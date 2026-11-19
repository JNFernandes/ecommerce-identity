import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ChangeUserStatusCommand } from '../../src/commands/change-user-status.command';
import { Email } from '../../src/domain/email.value-object';
import { User } from '../../src/domain/user.aggregate';
import { UserName } from '../../src/domain/user-name.value-object';
import { UserStatus } from '../../src/domain/user-status.enum';
import { UserEntity } from '../../src/infra/database/entities/user.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { SystemClock } from '../../src/infra/time/system-clock';
import { AdminTx, UserRepository } from '../../src/repositories/user.repository';
import { ChangeUserStatusService } from '../../src/services/change-user-status.service';

jest.setTimeout(180_000);

interface AuditRow {
  actorId: string;
  action: string;
  before: unknown;
  after: unknown;
}

/** A user repository whose admin transactions fail when appending the audit record. */
class FailingAuditUserRepository extends UserRepository {
  override inAdminTransaction<T>(work: (tx: AdminTx) => Promise<T>): Promise<T> {
    return super.inAdminTransaction((tx) => {
      const failing: AdminTx = Object.create(tx) as AdminTx;
      failing.appendAudit = (): Promise<void> => Promise.reject(new Error('audit write failed'));
      return work(failing);
    });
  }
}

describe('Status changes are audited atomically (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let users: UserRepository;
  let admin: User;

  /** Audit rows targeting a user. */
  function auditRowsFor(targetId: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT "actorId", "action", "before", "after" FROM "audit_records"
        WHERE "targetId" = $1 ORDER BY "occurredAt"`,
      [targetId],
    );
  }

  /** A new saved customer. */
  async function savedCustomer(email: string): Promise<User> {
    const user = User.registerCustomer(Email.create(email), UserName.create('Ana'), 'h');
    await users.save(user);
    return user;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    dataSource = new DataSource(
      buildDataSourceOptions({
        host: container.getHost(),
        port: container.getPort(),
        username: container.getUsername(),
        password: container.getPassword(),
        database: container.getDatabase(),
        migrationsRun: false,
      }),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
    users = new UserRepository(dataSource.getRepository(UserEntity));
    admin = User.registerAdmin(Email.create('admin@example.com'), UserName.create('Admin'), 'h');
    await users.save(admin);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should store one audit record per effective change, and none for a no-op', async () => {
    const service = new ChangeUserStatusService(users, new SystemClock());
    const customer = await savedCustomer('audited@example.com');

    await service.execute(new ChangeUserStatusCommand(customer.id, UserStatus.DISABLED, admin.id));
    await service.execute(new ChangeUserStatusCommand(customer.id, UserStatus.DISABLED, admin.id));
    await service.execute(new ChangeUserStatusCommand(customer.id, UserStatus.ACTIVE, admin.id));

    expect(await auditRowsFor(customer.id)).toEqual([
      {
        actorId: admin.id,
        action: 'USER_STATUS_CHANGED',
        before: { status: 'ACTIVE' },
        after: { status: 'DISABLED' },
      },
      {
        actorId: admin.id,
        action: 'USER_STATUS_CHANGED',
        before: { status: 'DISABLED' },
        after: { status: 'ACTIVE' },
      },
    ]);
  });

  it('should roll the status change back when the audit record cannot be written', async () => {
    const failing = new FailingAuditUserRepository(dataSource.getRepository(UserEntity));
    const service = new ChangeUserStatusService(failing, new SystemClock());
    const customer = await savedCustomer('rolled-back@example.com');

    await expect(
      service.execute(new ChangeUserStatusCommand(customer.id, UserStatus.DISABLED, admin.id)),
    ).rejects.toThrow('audit write failed');

    expect((await users.findById(customer.id))?.status).toBe(UserStatus.ACTIVE);
    expect(await auditRowsFor(customer.id)).toEqual([]);
  });
});
