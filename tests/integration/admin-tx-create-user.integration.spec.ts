import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AuditRecord } from '../../src/domain/audit/audit-record';
import { Email } from '../../src/domain/email.value-object';
import { DuplicateEmailError } from '../../src/domain/errors/duplicate-email.error';
import { Role } from '../../src/domain/role.enum';
import { User } from '../../src/domain/user.aggregate';
import { UserName } from '../../src/domain/user-name.value-object';
import { UserEntity } from '../../src/infra/database/entities/user.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { UserRepository } from '../../src/repositories/user.repository';

jest.setTimeout(180_000);

const ACTOR = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AT = new Date('2026-11-19T10:00:00.000Z');
const HASH = '$argon2id$v=19$m=1024,t=2,p=1$c2FsdA$aGFzaA';

/** A new user created by an admin with the given email and role. */
function newUser(email: string, role: Role = Role.ADMIN): User {
  return User.createByAdmin(Email.create(email), UserName.create('Bea'), HASH, [role]);
}

describe('AdminTx user creation (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let users: UserRepository;

  /** Number of users stored with this email (case-insensitive). */
  async function usersWithEmail(email: string): Promise<number> {
    const rows: { count: string }[] = await dataSource.query(
      'SELECT count(*) FROM "users" WHERE lower("email") = lower($1)',
      [email],
    );
    return Number(rows[0].count);
  }

  /** Audit rows targeting this user id. */
  async function auditRowsFor(
    targetId: string,
  ): Promise<{ actorId: string; action: string; before: unknown; after: unknown }[]> {
    return dataSource.query(
      `SELECT "actorId", "action", "before", "after" FROM "audit_records" WHERE "targetId" = $1`,
      [targetId],
    );
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
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should commit the user and its audit record together', async () => {
    const user = newUser('together@example.com', Role.CUSTOMER);

    await users.inAdminTransaction(async (tx) => {
      await tx.insertUser(user);
      await tx.appendAudit(AuditRecord.userCreated(ACTOR, user, AT));
    });

    const stored = await users.findById(user.id);
    expect(stored?.email.value).toBe('together@example.com');
    expect(stored?.customerId).toBe(user.customerId);
    expect(stored?.roles).toEqual([Role.CUSTOMER]);
    expect(await auditRowsFor(user.id)).toEqual([
      { actorId: ACTOR, action: 'USER_CREATED', before: null, after: { roles: ['CUSTOMER'] } },
    ]);
  });

  it('should keep neither when the work fails after both writes', async () => {
    const user = newUser('neither@example.com');

    await expect(
      users.inAdminTransaction(async (tx) => {
        await tx.insertUser(user);
        await tx.appendAudit(AuditRecord.userCreated(ACTOR, user, AT));
        throw new Error('later failure');
      }),
    ).rejects.toThrow('later failure');

    expect(await usersWithEmail('neither@example.com')).toBe(0);
    expect(await auditRowsFor(user.id)).toEqual([]);
  });

  it('should roll the user back when the audit record cannot be written', async () => {
    const first = newUser('first-audit@example.com');
    const firstRecord = AuditRecord.userCreated(ACTOR, first, AT);
    await users.inAdminTransaction(async (tx) => {
      await tx.insertUser(first);
      await tx.appendAudit(firstRecord);
    });
    const second = newUser('second-audit@example.com');

    // Re-using an existing record id makes the audit insert fail (primary key).
    await expect(
      users.inAdminTransaction(async (tx) => {
        await tx.insertUser(second);
        await tx.appendAudit(firstRecord);
      }),
    ).rejects.toThrow();

    expect(await usersWithEmail('second-audit@example.com')).toBe(0);
  });

  it('should reject an email already used, whatever its case, and write nothing', async () => {
    const existing = newUser('taken@example.com');
    await users.save(existing);
    const duplicate = User.createByAdmin(
      Email.create('  TAKEN@Example.com '),
      UserName.create('Other'),
      HASH,
      [Role.CUSTOMER],
    );

    await expect(
      users.inAdminTransaction(async (tx) => {
        await tx.insertUser(duplicate);
        await tx.appendAudit(AuditRecord.userCreated(ACTOR, duplicate, AT));
      }),
    ).rejects.toBeInstanceOf(DuplicateEmailError);

    expect(await usersWithEmail('taken@example.com')).toBe(1);
    expect(await auditRowsFor(duplicate.id)).toEqual([]);
  });

  it('should let only one of two concurrent creations with the same email commit', async () => {
    const results = await Promise.allSettled(
      ['race@example.com', 'RACE@example.com'].map((email) => {
        const user = newUser(email);
        return users.inAdminTransaction(async (tx) => {
          await tx.lockAdminChanges();
          await tx.insertUser(user);
          await tx.appendAudit(AuditRecord.userCreated(ACTOR, user, AT));
        });
      }),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DuplicateEmailError);
    expect(await usersWithEmail('race@example.com')).toBe(1);
  });
});
