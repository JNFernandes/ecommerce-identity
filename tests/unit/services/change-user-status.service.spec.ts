import { AuditRecord } from '../../../src/domain/audit/audit-record';
import { Logger } from '@nestjs/common';
import { ChangeUserStatusCommand } from '../../../src/commands/change-user-status.command';
import { Email } from '../../../src/domain/email.value-object';
import { CannotDisableSelfError } from '../../../src/domain/errors/cannot-disable-self.error';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../src/domain/errors/invalid-access-token.error';
import { LastActiveAdminError } from '../../../src/domain/errors/last-active-admin.error';
import { UserNotFoundError } from '../../../src/domain/errors/user-not-found.error';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { UserRepository, AdminTx } from '../../../src/repositories/user.repository';
import { ChangeUserStatusService } from '../../../src/services/change-user-status.service';
import { Clock } from '../../../src/services/ports/clock';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const CREATED_AT = new Date('2026-11-01T10:00:00.000Z');
const UPDATED_AT = new Date('2026-11-02T10:00:00.000Z');
const ADMIN_ID = '00000000-0000-4000-8000-00000000000a';
const CUSTOMER_ID = '00000000-0000-4000-8000-00000000000c';
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';

/** A stored user with the given id, email, role and status. */
function stored(id: string, email: string, role: Role, status: UserStatus): User {
  return User.restore({
    id,
    customerId: role === Role.CUSTOMER ? '00000000-0000-4000-8000-0000000000cc' : null,
    email: Email.create(email),
    name: UserName.create('Name'),
    passwordHash: '$argon2id$hash',
    roles: [role],
    status,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    lastLoginAt: new Date('2026-11-03T10:00:00.000Z'),
  });
}

/** In-memory {@link AdminTx} that records every call. */
class FakeTx implements AdminTx {
  readonly calls: string[] = [];
  readonly saved: User[] = [];
  revokedCount = 3;
  activeAdmins = 2;

  constructor(private readonly users: Map<string, User>) {}

  lockAdminChanges(): Promise<void> {
    this.calls.push('lockAdminChanges');
    return Promise.resolve();
  }

  findById(id: string): Promise<User | null> {
    this.calls.push(`findById:${id}`);
    return Promise.resolve(this.users.get(id) ?? null);
  }

  findByIdForUpdate(id: string): Promise<User | null> {
    this.calls.push(`findByIdForUpdate:${id}`);
    return Promise.resolve(this.users.get(id) ?? null);
  }

  countActiveAdmins(): Promise<number> {
    this.calls.push('countActiveAdmins');
    return Promise.resolve(this.activeAdmins);
  }

  saveStatus(user: User): Promise<void> {
    this.calls.push('saveStatus');
    this.saved.push(user);
    return Promise.resolve();
  }

  revokeAllRefreshTokens(userId: string, at: Date): Promise<number> {
    this.calls.push(`revokeAllRefreshTokens:${userId}:${at.toISOString()}`);
    return Promise.resolve(this.revokedCount);
  }

  insertUser(user: User): Promise<void> {
    this.calls.push(`insertUser:${user.id}`);
    return Promise.resolve();
  }

  appendAudit(record: AuditRecord): Promise<void> {
    this.calls.push(`appendAudit:${record.action}`);
    return Promise.resolve();
  }

  /** Whether any write happened. */
  wrote(): boolean {
    return this.calls.some(
      (call) =>
        call === 'saveStatus' ||
        call.startsWith('revokeAllRefreshTokens') ||
        call.startsWith('insertUser') ||
        call.startsWith('appendAudit'),
    );
  }
}

describe('ChangeUserStatusService', () => {
  let admin: User;
  let customer: User;
  let tx: FakeTx;
  let service: ChangeUserStatusService;
  let log: jest.SpyInstance;

  /** Rebuilds the fake transaction and the service around the given users. */
  function setUp(...users: User[]): void {
    tx = new FakeTx(new Map(users.map((user) => [user.id, user])));
    const repository = {
      inAdminTransaction: <T>(work: (t: AdminTx) => Promise<T>): Promise<T> => work(tx),
    } as unknown as UserRepository;
    service = new ChangeUserStatusService(repository, { now: () => NOW } as Clock);
  }

  const change = (targetId: string, status: UserStatus, actorId = ADMIN_ID): Promise<unknown> =>
    service.execute(new ChangeUserStatusCommand(targetId, status, actorId));

  /** Every line logged at `log` level. */
  const loggedLines = (): string[] => log.mock.calls.map((call: unknown[]) => String(call[0]));

  beforeEach(() => {
    admin = stored(ADMIN_ID, 'admin@example.com', Role.ADMIN, UserStatus.ACTIVE);
    customer = stored(CUSTOMER_ID, 'ana@example.com', Role.CUSTOMER, UserStatus.ACTIVE);
    setUp(admin, customer);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('disable', () => {
    it('should lock, re-read the actor, then lock the target, before writing', async () => {
      await change(CUSTOMER_ID, UserStatus.DISABLED);

      expect(tx.calls).toEqual([
        'lockAdminChanges',
        `findById:${ADMIN_ID}`,
        `findByIdForUpdate:${CUSTOMER_ID}`,
        'saveStatus',
        `revokeAllRefreshTokens:${CUSTOMER_ID}:${NOW.toISOString()}`,
      ]);
    });

    it('should save the DISABLED status with the change time', async () => {
      await change(CUSTOMER_ID, UserStatus.DISABLED);

      expect(tx.saved).toHaveLength(1);
      expect(tx.saved[0].id).toBe(CUSTOMER_ID);
      expect(tx.saved[0].status).toBe(UserStatus.DISABLED);
      expect(tx.saved[0].updatedAt).toEqual(NOW);
    });

    it('should log one line with the ids, both statuses and the revoked count', async () => {
      await change(CUSTOMER_ID, UserStatus.DISABLED);

      expect(loggedLines()).toEqual([
        `user status changed: actorId=${ADMIN_ID} targetId=${CUSTOMER_ID} ` +
          'from=ACTIVE to=DISABLED revokedTokens=3',
      ]);
    });

    it('should never log an email', async () => {
      await change(CUSTOMER_ID, UserStatus.DISABLED);

      for (const line of loggedLines()) {
        expect(line).not.toContain('@');
      }
    });

    it('should return the summary of the updated user', async () => {
      await expect(change(CUSTOMER_ID, UserStatus.DISABLED)).resolves.toEqual({
        id: CUSTOMER_ID,
        customerId: customer.customerId,
        email: 'ana@example.com',
        name: 'Name',
        roles: [Role.CUSTOMER],
        status: UserStatus.DISABLED,
        createdAt: CREATED_AT,
        lastLoginAt: customer.lastLoginAt,
      });
    });

    it('should write nothing and log nothing for an already DISABLED user', async () => {
      const disabled = stored(CUSTOMER_ID, 'ana@example.com', Role.CUSTOMER, UserStatus.DISABLED);
      setUp(admin, disabled);

      await expect(change(CUSTOMER_ID, UserStatus.DISABLED)).resolves.toMatchObject({
        status: UserStatus.DISABLED,
      });

      expect(tx.wrote()).toBe(false);
      expect(loggedLines()).toEqual([]);
    });

    it('should refuse a self-disable and write nothing', async () => {
      await expect(change(ADMIN_ID, UserStatus.DISABLED)).rejects.toBeInstanceOf(
        CannotDisableSelfError,
      );

      expect(tx.wrote()).toBe(false);
      expect(loggedLines()).toEqual([]);
    });
  });

  describe('last active admin', () => {
    const OTHER_ADMIN_ID = '00000000-0000-4000-8000-00000000000b';
    let otherAdmin: User;

    beforeEach(() => {
      otherAdmin = stored(OTHER_ADMIN_ID, 'other@example.com', Role.ADMIN, UserStatus.ACTIVE);
      setUp(admin, otherAdmin, customer);
    });

    it('should refuse to disable the last ACTIVE admin and write nothing', async () => {
      tx.activeAdmins = 1;

      await expect(change(OTHER_ADMIN_ID, UserStatus.DISABLED)).rejects.toBeInstanceOf(
        LastActiveAdminError,
      );

      expect(tx.wrote()).toBe(false);
      expect(otherAdmin.status).toBe(UserStatus.ACTIVE);
      expect(loggedLines()).toEqual([]);
    });

    it('should disable an admin when another ACTIVE admin exists', async () => {
      tx.activeAdmins = 2;

      await expect(change(OTHER_ADMIN_ID, UserStatus.DISABLED)).resolves.toMatchObject({
        status: UserStatus.DISABLED,
      });

      expect(tx.calls).toEqual([
        'lockAdminChanges',
        `findById:${ADMIN_ID}`,
        `findByIdForUpdate:${OTHER_ADMIN_ID}`,
        'countActiveAdmins',
        'saveStatus',
        `revokeAllRefreshTokens:${OTHER_ADMIN_ID}:${NOW.toISOString()}`,
      ]);
    });

    it('should report the self error, not the last-admin one, for the last admin disabling itself', async () => {
      setUp(admin, customer);
      tx.activeAdmins = 1;

      await expect(change(ADMIN_ID, UserStatus.DISABLED)).rejects.toBeInstanceOf(
        CannotDisableSelfError,
      );

      expect(tx.calls).not.toContain('countActiveAdmins');
      expect(tx.wrote()).toBe(false);
    });

    it('should not count admins for a customer target', async () => {
      await change(CUSTOMER_ID, UserStatus.DISABLED);

      expect(tx.calls).not.toContain('countActiveAdmins');
    });

    it('should not count admins for an already DISABLED admin target', async () => {
      setUp(admin, stored(OTHER_ADMIN_ID, 'other@example.com', Role.ADMIN, UserStatus.DISABLED));
      tx.activeAdmins = 1;

      await expect(change(OTHER_ADMIN_ID, UserStatus.DISABLED)).resolves.toMatchObject({
        status: UserStatus.DISABLED,
      });

      expect(tx.calls).not.toContain('countActiveAdmins');
      expect(tx.wrote()).toBe(false);
    });
  });

  describe('enable', () => {
    it('should save the ACTIVE status without revoking any token and log once', async () => {
      const disabled = stored(CUSTOMER_ID, 'ana@example.com', Role.CUSTOMER, UserStatus.DISABLED);
      setUp(admin, disabled);

      await expect(change(CUSTOMER_ID, UserStatus.ACTIVE)).resolves.toMatchObject({
        id: CUSTOMER_ID,
        status: UserStatus.ACTIVE,
      });

      expect(tx.calls).toEqual([
        'lockAdminChanges',
        `findById:${ADMIN_ID}`,
        `findByIdForUpdate:${CUSTOMER_ID}`,
        'saveStatus',
      ]);
      expect(tx.saved[0].updatedAt).toEqual(NOW);
      expect(loggedLines()).toEqual([
        `user status changed: actorId=${ADMIN_ID} targetId=${CUSTOMER_ID} ` +
          'from=DISABLED to=ACTIVE revokedTokens=0',
      ]);
    });

    it('should write nothing and log nothing for an already ACTIVE user', async () => {
      await expect(change(CUSTOMER_ID, UserStatus.ACTIVE)).resolves.toMatchObject({
        status: UserStatus.ACTIVE,
      });

      expect(tx.wrote()).toBe(false);
      expect(loggedLines()).toEqual([]);
    });

    it('should let an admin enable their own (already ACTIVE) account as a no-op', async () => {
      await expect(change(ADMIN_ID, UserStatus.ACTIVE)).resolves.toMatchObject({
        id: ADMIN_ID,
        status: UserStatus.ACTIVE,
      });

      expect(tx.wrote()).toBe(false);
    });
  });

  describe('acting admin and target checks', () => {
    it.each([
      ['missing', (): User[] => [customer]],
      [
        'DISABLED',
        (): User[] => [
          stored(ADMIN_ID, 'admin@example.com', Role.ADMIN, UserStatus.DISABLED),
          customer,
        ],
      ],
    ])('should refuse with USER_UNAVAILABLE when the acting admin is %s', async (_label, users) => {
      setUp(...users());

      const error: unknown = await change(CUSTOMER_ID, UserStatus.DISABLED).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(InvalidAccessTokenError);
      expect((error as InvalidAccessTokenError).reason).toBe(
        AccessTokenFailureReason.USER_UNAVAILABLE,
      );
      expect(tx.calls).toEqual(['lockAdminChanges', `findById:${ADMIN_ID}`]);
      expect(loggedLines()).toEqual([]);
    });

    it('should throw UserNotFoundError for an unknown target and write nothing', async () => {
      await expect(change(UNKNOWN_ID, UserStatus.DISABLED)).rejects.toBeInstanceOf(
        UserNotFoundError,
      );

      expect(tx.wrote()).toBe(false);
      expect(loggedLines()).toEqual([]);
    });

    it('should propagate a repository error unchanged', async () => {
      jest.spyOn(tx, 'saveStatus').mockRejectedValue(new Error('connection refused'));

      await expect(change(CUSTOMER_ID, UserStatus.DISABLED)).rejects.toThrow('connection refused');
      expect(loggedLines()).toEqual([]);
    });
  });
});
