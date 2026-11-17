import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapturingLogger } from './support/capturing-logger';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';

jest.setTimeout(180_000);

const PASSWORD = 'correct-horse-battery';
const SHORT_PASSWORD = 'nine-char';
const LONG_PASSWORD = 'p'.repeat(129);

describe('POST /auth/register rejections (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let sequence = 0;

  /** A new email each call, so accepted cases never collide. */
  const uniqueEmail = (): string => `user${++sequence}@example.com`;

  const register = (body: unknown): request.Test =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send(body as object);

  const countUsers = async (): Promise<number> => {
    const rows: { count: string }[] = await app
      .get(DataSource)
      .query('SELECT count(*) AS "count" FROM "users"');
    return Number(rows[0].count);
  };

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    process.env.RATE_LIMIT_REGISTER_LIMIT = '1000';
    app = await createTestApp(logger);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  describe('400 Bad Request', () => {
    const valid = { email: 'bad@example.com', name: 'Ana', password: PASSWORD };

    it.each<[string, Record<string, unknown>]>([
      ['an invalid email', { ...valid, email: 'not-an-email' }],
      ['a 9-char password', { ...valid, password: SHORT_PASSWORD }],
      ['a 129-char password', { ...valid, password: LONG_PASSWORD }],
      ['a password equal to the email in another case', { ...valid, password: 'BAD@example.com' }],
      ['a password equal to the email with spaces', { ...valid, password: '  bad@example.com ' }],
      ['an empty name', { ...valid, name: '   ' }],
      ['a 101-char name', { ...valid, name: 'n'.repeat(101) }],
      ['a roles property', { ...valid, roles: ['ADMIN'] }],
      ['a status property', { ...valid, status: 'ACTIVE' }],
      ['an id property', { ...valid, id: '7d6f2c1e-0000-4000-8000-000000000000' }],
      ['a customerId property', { ...valid, customerId: '1b2c3d4e-0000-4000-8000-000000000000' }],
      ['an unknown property', { ...valid, nickname: 'ana' }],
      ['a missing password', { email: valid.email, name: valid.name }],
      ['a non-string password', { ...valid, password: 12345678901 }],
    ])('should reject %s and create no account', async (_case, body) => {
      const before = await countUsers();

      const response = await register(body);

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(await countUsers()).toBe(before);
    });

    it('should reject malformed JSON and create no account', async () => {
      const before = await countUsers();

      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .set('Content-Type', 'application/json')
        .send('{"email": "bad@example.com", ');

      expect(response.status).toBe(400);
      expect(await countUsers()).toBe(before);
    });
  });

  describe('boundaries accepted', () => {
    it.each<[string, string, string]>([
      ['a 10-char password', 'Ana', 'ten-chars!'],
      ['a 128-char password', 'Ana', 'p'.repeat(128)],
      ['a 1-char name', 'A', PASSWORD],
      ['a 100-char name', 'n'.repeat(100), PASSWORD],
    ])('should accept %s', async (_case, name, password) => {
      const response = await register({ email: uniqueEmail(), name, password });

      expect(response.status).toBe(201);
    });
  });

  describe('409 Conflict', () => {
    it('should reject an email registered in another case', async () => {
      expect(
        (await register({ email: 'ana@example.com', name: 'Ana', password: PASSWORD })).status,
      ).toBe(201);
      const before = await countUsers();

      const response = await register({
        email: 'ANA@example.com',
        name: 'Ana',
        password: PASSWORD,
      });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        statusCode: 409,
        message: 'email already registered',
        error: 'Conflict',
      });
      expect(await countUsers()).toBe(before);
    });

    it('should accept exactly one of two concurrent registrations of one email', async () => {
      const body = { email: 'race@example.com', name: 'Race', password: PASSWORD };

      const responses = await Promise.all([register(body), register(body)]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const rows: unknown[] = await app
        .get(DataSource)
        .query('SELECT 1 FROM "users" WHERE lower("email") = $1', ['race@example.com']);
      expect(rows).toHaveLength(1);
    });
  });

  it('should never log a submitted password', () => {
    const text = logger.text();

    for (const password of [PASSWORD, SHORT_PASSWORD, LONG_PASSWORD, 'ten-chars!']) {
      expect(text).not.toContain(password);
    }
  });
});
