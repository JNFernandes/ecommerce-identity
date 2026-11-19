import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AuditAction } from '../../src/domain/audit/audit-action.enum';
import { AuditRecordEntity } from '../../src/infra/database/entities/audit-record.entity';
import { buildDataSourceOptions } from '../../src/infra/database/typeorm-options';
import { ListAuditRecordsQuery } from '../../src/queries/list-audit-records.query';
import { AuditRecordRepository } from '../../src/repositories/audit-record.repository';

jest.setTimeout(180_000);

const CALLER = randomUUID();
const ADMIN_A = randomUUID();
const ADMIN_B = randomUUID();
const USER_X = randomUUID();
const USER_Y = randomUUID();
const SAME_TIME = '2026-11-19T10:00:00.000Z';

interface Seed {
  id: string;
  actorId: string;
  targetId: string;
  action: AuditAction;
  at: string;
}

/** Ids ordered so the tie-break (`id` desc) is predictable. */
const IDS = Array.from({ length: 5 }, () => randomUUID()).sort();

/** Seed rows; two share `SAME_TIME`. */
const SEEDS: Seed[] = [
  {
    id: IDS[0],
    actorId: ADMIN_A,
    targetId: USER_X,
    action: AuditAction.USER_CREATED,
    at: '2026-11-19T09:00:00.000Z',
  },
  {
    id: IDS[1],
    actorId: ADMIN_A,
    targetId: USER_X,
    action: AuditAction.ROLES_CHANGED,
    at: SAME_TIME,
  },
  {
    id: IDS[2],
    actorId: ADMIN_B,
    targetId: USER_Y,
    action: AuditAction.USER_STATUS_CHANGED,
    at: SAME_TIME,
  },
  {
    id: IDS[3],
    actorId: ADMIN_B,
    targetId: USER_X,
    action: AuditAction.USER_STATUS_CHANGED,
    at: '2026-11-19T11:00:00.000Z',
  },
  {
    id: IDS[4],
    actorId: ADMIN_A,
    targetId: USER_Y,
    action: AuditAction.USER_CREATED,
    at: '2026-11-19T12:00:00.000Z',
  },
];

/** Expected newest-first id order of all seeds. */
const NEWEST_FIRST = [IDS[4], IDS[3], IDS[2], IDS[1], IDS[0]];

describe('AuditRecordRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: AuditRecordRepository;

  /** Runs a query and returns the ids of the page. */
  async function ids(
    limit: number,
    offset: number,
    filters: { actorId?: string; targetId?: string; action?: AuditAction } = {},
  ): Promise<{ ids: string[]; total: number }> {
    const page = await repository.findPage(
      new ListAuditRecordsQuery(
        CALLER,
        limit,
        offset,
        filters.actorId,
        filters.targetId,
        filters.action,
      ),
    );
    return { ids: page.items.map((item) => item.id), total: page.total };
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
    repository = new AuditRecordRepository(dataSource.getRepository(AuditRecordEntity));
    for (const seed of SEEDS) {
      await dataSource.query(
        `INSERT INTO "audit_records" ("id", "actorId", "action", "targetId", "before", "after", "occurredAt")
         VALUES ($1, $2, $3, $4, '{"status":"ACTIVE"}', '{"status":"DISABLED"}', $5)`,
        [seed.id, seed.actorId, seed.action, seed.targetId, seed.at],
      );
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  });

  it('should return every record newest first with the id tie-break and the total', async () => {
    await expect(ids(20, 0)).resolves.toEqual({ ids: NEWEST_FIRST, total: 5 });
  });

  it('should map each row to the read model with createdAt from occurredAt', async () => {
    const page = await repository.findPage(new ListAuditRecordsQuery(CALLER, 1, 0));

    expect(page).toEqual({
      items: [
        {
          id: IDS[4],
          actorId: ADMIN_A,
          action: AuditAction.USER_CREATED,
          targetId: USER_Y,
          before: { status: 'ACTIVE' },
          after: { status: 'DISABLED' },
          createdAt: new Date('2026-11-19T12:00:00.000Z'),
        },
      ],
      total: 5,
      limit: 1,
      offset: 0,
    });
  });

  it('should return each record exactly once when paging', async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      seen.push(...(await ids(2, offset)).ids);
    }
    expect(seen).toEqual(NEWEST_FIRST);
  });

  it('should return no items but the real total past the end', async () => {
    await expect(ids(20, 10)).resolves.toEqual({ ids: [], total: 5 });
  });

  it('should filter by actor, target and action', async () => {
    await expect(ids(20, 0, { actorId: ADMIN_B })).resolves.toEqual({
      ids: [IDS[3], IDS[2]],
      total: 2,
    });
    await expect(ids(20, 0, { targetId: USER_Y })).resolves.toEqual({
      ids: [IDS[4], IDS[2]],
      total: 2,
    });
    await expect(ids(20, 0, { action: AuditAction.USER_CREATED })).resolves.toEqual({
      ids: [IDS[4], IDS[0]],
      total: 2,
    });
  });

  it('should combine filters with AND', async () => {
    await expect(
      ids(20, 0, { actorId: ADMIN_A, targetId: USER_X, action: AuditAction.ROLES_CHANGED }),
    ).resolves.toEqual({ ids: [IDS[1]], total: 1 });
    await expect(
      ids(20, 0, { actorId: ADMIN_B, action: AuditAction.USER_CREATED }),
    ).resolves.toEqual({ ids: [], total: 0 });
  });
});
