import { Logger } from '@nestjs/common';
import { ChangeUserRolesCommand } from '../../../src/commands/change-user-roles.command';
import { AuditAction } from '../../../src/domain/audit/audit-action.enum';
import { AuditRecord } from '../../../src/domain/audit/audit-record';
import { Email } from '../../../src/domain/email.value-object';
import { CannotRemoveOwnAdminError } from '../../../src/domain/errors/cannot-remove-own-admin.error';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../src/domain/errors/invalid-access-token.error';
import { LastActiveAdminError } from '../../../src/domain/errors/last-active-admin.error';
import { UserNotFoundError } from '../../../src/domain/errors/user-not-found.error';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { AdminTx, UserRepository } from '../../../src/repositories/user.repository';
import { ChangeUserRolesService } from '../../../src/services/change-user-roles.service';
import { Clock } from '../../../src/services/ports/clock';
import { UserEventDispatcher } from '../../../src/services/user-event-dispatcher';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const ADMIN_ID = '00000000-0000-4000-8000-00000000000a';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-00000000000b';
const CUSTOMER_ID = '00000000-0000-4000-8000-00000000000c';
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';
const CUSTOMER_CUSTOMER_ID = '00000000-0000-4000-8000-0000000000cc';

/** A stored user with the given id, roles and status. */
function stored(id: string, roles: Role[], status = UserStatus.ACTIVE): User {
  return User.restore({
    id,
    customerId: roles.includes(Role.CUSTOMER) ? CUSTOMER_CUSTOMER_ID : null,
    email: Email.create(`${id.slice(-2)}@example.com`),
    name: UserName.create('Name'),
    passwordHash: '$argon2id$hash',
    roles,
    status,
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    updatedAt: new Date('2026-11-02T10:00:00.000Z'),
    lastLoginAt: null,
  });
}

/** In-memory {@link AdminTx} that records every call. */
class FakeTx implements AdminTx {
  readonly calls: string[] = [];
  readonly audits: AuditRecord[] = [];
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

  saveStatus(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }

  saveRoles(): Promise<void> {
    this.calls.push('saveRoles');
    return Promise.resolve();
  }

  revokeAllRefreshTokens(userId: string): Promise<number> {
    this.calls.push(`revokeAllRefreshTokens:${userId}`);
    return Promise.resolve(2);
  }

  insertUser(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }

  appendAudit(record: AuditRecord): Promise<void> {
    this.calls.push(`appendAudit:${record.action}`);
    this.audits.push(record);
    return Promise.resolve();
  }

  /** Whether any write happened. */
  wrote(): boolean {
    return this.calls.some(
      (call) =>
        call === 'saveRoles' ||
        call.startsWith('revokeAllRefreshTokens') ||
        call.startsWith('appendAudit'),
    );
  }
}

describe('ChangeUserRolesService', () => {
  let tx: FakeTx;
  let dispatch: jest.Mock<Promise<void>, [User]>;
  let service: ChangeUserRolesService;
  let log: jest.SpyInstance;

  /** Rebuilds the fake transaction and the service around the given users. */
  function setUp(...users: User[]): void {
    tx = new FakeTx(new Map(users.map((user) => [user.id, user])));
    const repository = {
      inAdminTransaction: <T>(work: (t: AdminTx) => Promise<T>): Promise<T> => work(tx),
    } as unknown as UserRepository;
    dispatch = jest.fn<Promise<void>, [User]>().mockResolvedValue(undefined);
    service = new ChangeUserRolesService(
      repository,
      { dispatch } as unknown as UserEventDispatcher,
      { now: () => NOW } as Clock,
    );
  }

  const change = (targetId: string, roles: Role[], actorId = ADMIN_ID): Promise<unknown> =>
    service.execute(new ChangeUserRolesCommand(targetId, roles, actorId));

  beforeEach(() => {
    setUp(
      stored(ADMIN_ID, [Role.ADMIN]),
      stored(OTHER_ADMIN_ID, [Role.ADMIN]),
      stored(CUSTOMER_ID, [Role.CUSTOMER]),
    );
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should grant without revoking sessions or counting admins, then audit', async () => {
    const result = await change(CUSTOMER_ID, [Role.CUSTOMER, Role.ADMIN]);

    expect(tx.calls).toEqual([
      'lockAdminChanges',
      `findById:${ADMIN_ID}`,
      `findByIdForUpdate:${CUSTOMER_ID}`,
      'saveRoles',
      `appendAudit:${AuditAction.ROLES_CHANGED}`,
    ]);
    expect(result).toMatchObject({
      id: CUSTOMER_ID,
      customerId: CUSTOMER_CUSTOMER_ID,
      roles: [Role.CUSTOMER, Role.ADMIN],
    });
    expect(tx.audits[0].before).toEqual({ roles: [Role.CUSTOMER] });
    expect(tx.audits[0].after).toEqual({ roles: [Role.CUSTOMER, Role.ADMIN] });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('should count admins, then revoke every refresh token when ADMIN is removed', async () => {
    await change(OTHER_ADMIN_ID, [Role.CUSTOMER]);

    expect(tx.calls).toEqual([
      'lockAdminChanges',
      `findById:${ADMIN_ID}`,
      `findByIdForUpdate:${OTHER_ADMIN_ID}`,
      'countActiveAdmins',
      'saveRoles',
      `revokeAllRefreshTokens:${OTHER_ADMIN_ID}`,
      `appendAudit:${AuditAction.ROLES_CHANGED}`,
    ]);
  });

  it('should revoke sessions but not count admins when CUSTOMER is removed', async () => {
    await change(CUSTOMER_ID, [Role.ADMIN]);

    expect(tx.calls).not.toContain('countActiveAdmins');
    expect(tx.calls).toContain(`revokeAllRefreshTokens:${CUSTOMER_ID}`);
  });

  it('should dispatch the UserRegistered event of a first CUSTOMER grant after the change', async () => {
    await change(OTHER_ADMIN_ID, [Role.ADMIN, Role.CUSTOMER]);

    const user = dispatch.mock.calls[0][0];
    expect(user.customerId).toEqual(expect.any(String));
    expect(user.pullDomainEvents()).toHaveLength(1);
  });

  it('should log once with actor, target and roles before and after', async () => {
    await change(CUSTOMER_ID, [Role.ADMIN]);

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain(`actorId=${ADMIN_ID}`);
    expect(line).toContain(`targetId=${CUSTOMER_ID}`);
    expect(line).toContain('before=CUSTOMER after=ADMIN');
    expect(line).not.toContain('@example.com');
  });

  it('should write, log and dispatch nothing for a no-op', async () => {
    const result = await change(CUSTOMER_ID, [Role.CUSTOMER]);

    expect(result).toMatchObject({ id: CUSTOMER_ID, roles: [Role.CUSTOMER] });
    expect(tx.wrote()).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('should refuse an admin removing their own ADMIN before counting admins', async () => {
    await expect(change(ADMIN_ID, [Role.CUSTOMER])).rejects.toThrow(CannotRemoveOwnAdminError);

    expect(tx.calls).not.toContain('countActiveAdmins');
    expect(tx.wrote()).toBe(false);
  });

  it('should refuse removing ADMIN from the last ACTIVE admin', async () => {
    tx.activeAdmins = 1;

    await expect(change(OTHER_ADMIN_ID, [Role.CUSTOMER])).rejects.toThrow(LastActiveAdminError);
    expect(tx.wrote()).toBe(false);
  });

  it('should allow removing ADMIN from a DISABLED admin whatever the count', async () => {
    setUp(
      stored(ADMIN_ID, [Role.ADMIN]),
      stored(OTHER_ADMIN_ID, [Role.ADMIN], UserStatus.DISABLED),
    );
    tx.activeAdmins = 1;

    await expect(change(OTHER_ADMIN_ID, [Role.CUSTOMER])).resolves.toBeDefined();
  });

  it('should refuse invalid roles without writing', async () => {
    await expect(change(CUSTOMER_ID, [])).rejects.toThrow(UserValidationError);
    expect(tx.wrote()).toBe(false);
  });

  it('should throw UserNotFoundError for an unknown target', async () => {
    await expect(change(UNKNOWN_ID, [Role.ADMIN])).rejects.toThrow(UserNotFoundError);
  });

  it.each([
    ['missing', UNKNOWN_ID],
    ['a customer', CUSTOMER_ID],
  ])('should refuse an actor who is %s with USER_UNAVAILABLE', async (_label, actorId) => {
    await expect(change(OTHER_ADMIN_ID, [Role.CUSTOMER], actorId)).rejects.toEqual(
      new InvalidAccessTokenError(AccessTokenFailureReason.USER_UNAVAILABLE),
    );
    expect(tx.calls).toEqual(['lockAdminChanges', `findById:${actorId}`]);
  });

  it('should refuse a DISABLED actor', async () => {
    setUp(
      stored(ADMIN_ID, [Role.ADMIN], UserStatus.DISABLED),
      stored(CUSTOMER_ID, [Role.CUSTOMER]),
    );

    await expect(change(CUSTOMER_ID, [Role.ADMIN])).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });
});
