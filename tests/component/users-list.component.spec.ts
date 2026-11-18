import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestApp,
  startPostgres,
  useAdminSeed,
  useUnreachableKafka,
} from './support/test-app';
import { loginAs, registerAndLogin } from './support/token-flow';

jest.setTimeout(240_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const ITEM_KEYS = [
  'createdAt',
  'customerId',
  'email',
  'id',
  'lastLoginAt',
  'name',
  'roles',
  'status',
].sort();

interface Item {
  id: string;
  customerId?: string;
  email: string;
  name: string;
  roles: string[];
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

interface Page {
  items: Item[];
  total: number;
  limit: number;
  offset: number;
}

describe('GET /users (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let adminToken: string;

  /** Calls `GET /users` as the admin and expects 200. */
  async function list(query: Record<string, string | number> = {}): Promise<Page> {
    const response = await request(app.getHttpServer())
      .get('/users')
      .query(query)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    return response.body as Page;
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should list only the seeded admin before any registration', async () => {
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;

    const page = await list();

    expect(page).toMatchObject({ total: 1, limit: 20, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ email: ADMIN_EMAIL, roles: ['ADMIN'] });
    expect(page.items[0]).not.toHaveProperty('customerId');
    expect(page.items[0].lastLoginAt).not.toBeNull();
  });

  describe('with customers', () => {
    beforeAll(async () => {
      for (const email of ['ana@example.com', 'anabela@example.com', 'bob@example.com']) {
        await registerAndLogin(app, email);
      }
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'never@example.com', name: 'Never', password: 'correct-horse-battery' })
        .expect(201);
      await app
        .get(DataSource)
        .query(`UPDATE "users" SET "status" = 'DISABLED' WHERE "email" = 'bob@example.com'`);
    });

    it('should return every user newest first with the default paging', async () => {
      const page = await list();

      expect(page).toMatchObject({ total: 5, limit: 20, offset: 0 });
      expect(page.items.map((item) => item.email)).toEqual([
        'never@example.com',
        'bob@example.com',
        'anabela@example.com',
        'ana@example.com',
        ADMIN_EMAIL,
      ]);
    });

    it('should return exactly the contract fields and never a password or hash', async () => {
      const response = await request(app.getHttpServer())
        .get('/users')
        .set('Authorization', `Bearer ${adminToken}`);
      const page = response.body as Page;

      for (const item of page.items) {
        const expected = item.roles.includes('ADMIN')
          ? ITEM_KEYS.filter((key) => key !== 'customerId')
          : ITEM_KEYS;
        expect(Object.keys(item).sort()).toEqual(expected);
      }
      expect(response.text).not.toMatch(/password|passwordHash|\$argon2/i);
    });

    it('should show lastLoginAt after a login and null before the first one', async () => {
      const page = await list();
      const byEmail = new Map(page.items.map((item) => [item.email, item]));

      expect(byEmail.get('never@example.com')?.lastLoginAt).toBeNull();
      expect(Date.parse(byEmail.get('ana@example.com')?.lastLoginAt ?? '')).not.toBeNaN();
    });

    it('should return the requested slice with an unchanged total', async () => {
      const page = await list({ limit: 2, offset: 1 });

      expect(page).toMatchObject({ total: 5, limit: 2, offset: 1 });
      expect(page.items.map((item) => item.email)).toEqual([
        'bob@example.com',
        'anabela@example.com',
      ]);
    });

    it('should return no items but the real total past the end', async () => {
      const page = await list({ offset: 99 });

      expect(page).toEqual({ items: [], total: 5, limit: 20, offset: 99 });
    });

    it('should filter by role', async () => {
      const admins = await list({ role: 'ADMIN' });
      const customers = await list({ role: 'CUSTOMER' });

      expect(admins.items.map((item) => item.email)).toEqual([ADMIN_EMAIL]);
      expect(admins.total).toBe(1);
      expect(customers.total).toBe(4);
    });

    it('should filter by status', async () => {
      const page = await list({ status: 'DISABLED' });

      expect(page.items.map((item) => item.email)).toEqual(['bob@example.com']);
      expect(page.total).toBe(1);
    });

    it('should filter by a case-insensitive email prefix', async () => {
      const page = await list({ email: 'AN' });

      expect(page.items.map((item) => item.email)).toEqual([
        'anabela@example.com',
        'ana@example.com',
      ]);
      expect(page.total).toBe(2);
    });

    it('should ignore an empty email filter', async () => {
      expect((await list({ email: '' })).total).toBe(5);
    });

    it('should combine the filters with AND', async () => {
      const page = await list({ role: 'CUSTOMER', status: 'ACTIVE', email: 'an', limit: 1 });

      expect(page.items.map((item) => item.email)).toEqual(['anabela@example.com']);
      expect(page.total).toBe(2);
    });
  });
});
