import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestApp,
  startPostgres,
  useAdminSeed,
  useUnreachableKafka,
} from './support/test-app';
import { loginAs } from './support/token-flow';

jest.setTimeout(180_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';

/** The seed and the admin endpoints never need Kafka. */
describe('admin user endpoints with Kafka unreachable (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;

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

  it('should seed the admin, log it in and serve both endpoints', async () => {
    const { accessToken } = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const auth = `Bearer ${accessToken}`;

    const list = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', auth)
      .expect(200);
    const [admin] = list.body.items as { id: string; email: string }[];
    expect(admin.email).toBe(ADMIN_EMAIL);

    const one = await request(app.getHttpServer())
      .get(`/users/${admin.id}`)
      .set('Authorization', auth)
      .expect(200);
    expect(one.body).toEqual(admin);
  });
});
