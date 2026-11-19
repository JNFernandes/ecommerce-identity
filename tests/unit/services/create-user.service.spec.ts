import { Logger } from '@nestjs/common';
import { CreateUserCommand } from '../../../src/commands/create-user.command';
import { AuditAction } from '../../../src/domain/audit/audit-action.enum';
import { AuditRecord } from '../../../src/domain/audit/audit-record';
import { Email } from '../../../src/domain/email.value-object';
import { DuplicateEmailError } from '../../../src/domain/errors/duplicate-email.error';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../src/domain/errors/invalid-access-token.error';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { UserRegistered } from '../../../src/domain/events/user-registered.event';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { AdminTx, UserRepository } from '../../../src/repositories/user.repository';
import { Clock } from '../../../src/services/ports/clock';
import { PasswordHasher } from '../../../src/services/ports/password-hasher';
import { CreateUserService } from '../../../src/services/create-user.service';
import { UserEventDispatcher } from '../../../src/services/user-event-dispatcher';

const NOW = new Date('2026-11-19T10:00:00.000Z');
const HASH = '$argon2id$v=19$m=1024,t=2,p=1$salt$digest';
const PASSWORD = 'correct-horse-battery';

/** In-memory {@link AdminTx} recording every call in one shared order list. */
class FakeTx implements AdminTx {
  readonly inserted: User[] = [];
  readonly audits: AuditRecord[] = [];
  insertError: Error | null = null;

  constructor(
    private readonly users: Map<string, User>,
    private readonly order: string[],
  ) {}

  lockAdminChanges(): Promise<void> {
    this.order.push('lock');
    return Promise.resolve();
  }

  findById(id: string): Promise<User | null> {
    this.order.push('findActor');
    return Promise.resolve(this.users.get(id) ?? null);
  }

  findByIdForUpdate(): Promise<User | null> {
    return Promise.reject(new Error('not used'));
  }

  countActiveAdmins(): Promise<number> {
    return Promise.reject(new Error('not used'));
  }

  saveStatus(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }

  revokeAllRefreshTokens(): Promise<number> {
    return Promise.reject(new Error('not used'));
  }

  insertUser(user: User): Promise<void> {
    this.order.push('insert');
    if (this.insertError !== null) {
      return Promise.reject(this.insertError);
    }
    this.inserted.push(user);
    return Promise.resolve();
  }

  appendAudit(record: AuditRecord): Promise<void> {
    this.order.push('audit');
    this.audits.push(record);
    return Promise.resolve();
  }
}

describe('CreateUserService', () => {
  let actor: User;
  let order: string[];
  let tx: FakeTx;
  let hash: jest.Mock<Promise<string>, [string]>;
  let inAdminTransaction: jest.Mock;
  let dispatch: jest.Mock<Promise<void>, [User]>;
  let log: jest.SpyInstance;
  let service: CreateUserService;

  const command = (overrides: Partial<CreateUserCommand> = {}): CreateUserCommand => {
    const base = new CreateUserCommand(actor.id, ' Bea@Example.com ', ' Bea ', PASSWORD, [
      Role.ADMIN,
    ]);
    return Object.assign(base, overrides);
  };

  beforeEach(() => {
    actor = User.registerAdmin(Email.create('root@example.com'), UserName.create('Root'), HASH);
    order = [];
    tx = new FakeTx(new Map([[actor.id, actor]]), order);
    hash = jest.fn<Promise<string>, [string]>(async () => {
      order.push('hash');
      return HASH;
    });
    inAdminTransaction = jest.fn(<T>(work: (t: AdminTx) => Promise<T>): Promise<T> => work(tx));
    dispatch = jest.fn(async (user: User) => {
      order.push('dispatch');
      user.pullDomainEvents();
    });
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      order.push('log');
    });
    service = new CreateUserService(
      { hash, verify: jest.fn(), dummyHash: jest.fn() } as PasswordHasher,
      { inAdminTransaction } as unknown as UserRepository,
      { dispatch } as unknown as UserEventDispatcher,
      { now: () => NOW } as Clock,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should create an ACTIVE admin without customerId and audit it', async () => {
    const summary = await service.execute(command());

    expect(summary).toMatchObject({
      email: 'bea@example.com',
      name: 'Bea',
      roles: [Role.ADMIN],
      status: UserStatus.ACTIVE,
      customerId: null,
      lastLoginAt: null,
    });
    expect(tx.inserted).toHaveLength(1);
    expect(tx.inserted[0].passwordHash).toBe(HASH);
    expect(tx.audits).toHaveLength(1);
    const [record] = tx.audits;
    expect(record.actorId).toBe(actor.id);
    expect(record.action).toBe(AuditAction.USER_CREATED);
    expect(record.targetId).toBe(summary.id);
    expect(record.before).toBeNull();
    expect(record.after).toEqual({ roles: [Role.ADMIN] });
    expect(record.occurredAt).toBe(NOW);
  });

  it('should create a customer with a customerId and hand its UserRegistered to the dispatcher', async () => {
    let events: unknown[] = [];
    dispatch.mockImplementation(async (user: User) => {
      events = user.pullDomainEvents();
    });

    const summary = await service.execute(command({ roles: [Role.CUSTOMER] }));

    expect(summary.customerId).toEqual(expect.any(String));
    expect(summary.customerId).not.toBe(summary.id);
    expect(dispatch).toHaveBeenCalledWith(tx.inserted[0]);
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(UserRegistered);
    expect(tx.audits[0].after).toEqual({ roles: [Role.CUSTOMER] });
  });

  it('should hash, then lock, re-read the actor, insert, audit, log and dispatch in that order', async () => {
    await service.execute(command());

    expect(order).toEqual(['hash', 'lock', 'findActor', 'insert', 'audit', 'log', 'dispatch']);
  });

  it('should log the actor, the new id and the role, and nothing personal', async () => {
    const summary = await service.execute(command());

    expect(log).toHaveBeenCalledWith(
      `user created: actorId=${actor.id} targetId=${summary.id} roles=ADMIN`,
    );
    const line = String(log.mock.calls[0][0]);
    for (const secret of ['bea@example.com', 'Bea', PASSWORD, HASH]) {
      expect(line).not.toContain(secret);
    }
  });

  it.each([
    ['an invalid email', { email: 'not-an-email' }],
    ['an empty name', { name: '   ' }],
    ['a short password', { password: 'short' }],
    ['a password equal to the email', { password: 'bea@example.com' }],
    ['no role', { roles: [] }],
    ['both roles', { roles: [Role.CUSTOMER, Role.ADMIN] }],
  ])('should reject %s before hashing and without a transaction', async (_label, overrides) => {
    await expect(service.execute(command(overrides))).rejects.toBeInstanceOf(UserValidationError);

    expect(hash).not.toHaveBeenCalled();
    expect(inAdminTransaction).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', (): void => undefined],
    ['disabled', (): void => void actor.disable('someone-else', NOW)],
  ])('should refuse a %s acting admin with the generic 401 error', async (_label, arrange) => {
    arrange();
    const missing = _label === 'missing';
    const run = missing
      ? service.execute(command({ actingAdminId: '00000000-0000-4000-8000-000000000000' }))
      : service.execute(command());

    await expect(run).rejects.toEqual(
      new InvalidAccessTokenError(AccessTokenFailureReason.USER_UNAVAILABLE),
    );
    expect(tx.inserted).toEqual([]);
    expect(tx.audits).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('should refuse an acting user who is not an admin', async () => {
    const customer = User.registerCustomer(
      Email.create('cus@example.com'),
      UserName.create('Cus'),
      HASH,
    );
    tx = new FakeTx(new Map([[customer.id, customer]]), order);

    await expect(service.execute(command({ actingAdminId: customer.id }))).rejects.toBeInstanceOf(
      InvalidAccessTokenError,
    );
    expect(tx.inserted).toEqual([]);
  });

  it('should propagate DuplicateEmailError without auditing, logging or dispatching', async () => {
    tx.insertError = new DuplicateEmailError();

    await expect(service.execute(command())).rejects.toBeInstanceOf(DuplicateEmailError);

    expect(tx.audits).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
