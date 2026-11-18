import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import { familyRows, postRefresh, registerAndLogin, rowOf, TokenPair } from './support/token-flow';

jest.setTimeout(180_000);

describe('refresh token reuse detection (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    app = await createTestApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should revoke the whole family when a used refresh token is presented', async () => {
    const { tokens } = await registerAndLogin(app, 'reuse@example.com');
    const rt1 = tokens.refreshToken;
    const first = await postRefresh(app, rt1);
    expect(first.status).toBe(200);
    const rt2 = (first.body as TokenPair).refreshToken;

    const reuse = await postRefresh(app, rt1);

    expect(reuse.status).toBe(401);
    const familyId = (await rowOf(dataSource, rt1))?.familyId ?? '';
    const rows = await familyRows(dataSource, familyId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect((await postRefresh(app, rt2)).status).toBe(401);
  });

  it('should let exactly one of many parallel refreshes with one token succeed and revoke the family', async () => {
    const { tokens } = await registerAndLogin(app, 'parallel@example.com');

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => postRefresh(app, tokens.refreshToken)),
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 401)).toHaveLength(9);
    const familyId = (await rowOf(dataSource, tokens.refreshToken))?.familyId ?? '';
    const rows = await familyRows(dataSource, familyId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });
});
