import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import { FLOW_PASSWORD, registerAndLogin, TokenPair } from './support/token-flow';

jest.setTimeout(180_000);

/** Authorization values a public route must ignore: none, and an invalid token. */
const HEADER_CASES: [string, string | undefined][] = [
  ['without a token', undefined],
  ['with an invalid token', 'Bearer invalid'],
];

/** Public routes behave as before whatever `Authorization` header they get (US4). */
describe('public routes (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    app = await createTestApp(undefined, [], { swagger: true });
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  function withHeader(test: request.Test, authorization: string | undefined): request.Test {
    return authorization === undefined ? test : test.set('Authorization', authorization);
  }

  describe.each(HEADER_CASES)('%s', (label, authorization) => {
    const slug = label.replace(/\W+/g, '-');
    let tokens: TokenPair;

    it('should register', async () => {
      const response = await withHeader(
        request(app.getHttpServer()).post('/auth/register'),
        authorization,
      ).send({ email: `register${slug}@example.com`, name: 'Ana', password: FLOW_PASSWORD });

      expect(response.status).toBe(201);
    });

    it('should log in', async () => {
      await registerAndLogin(app, `login${slug}@example.com`);
      const response = await withHeader(
        request(app.getHttpServer()).post('/auth/login'),
        authorization,
      ).send({ email: `login${slug}@example.com`, password: FLOW_PASSWORD });

      expect(response.status).toBe(200);
      tokens = response.body as TokenPair;
    });

    it('should refresh', async () => {
      const response = await withHeader(
        request(app.getHttpServer()).post('/auth/refresh'),
        authorization,
      ).send({ refreshToken: tokens.refreshToken });

      expect(response.status).toBe(200);
      tokens = response.body as TokenPair;
    });

    it('should log out', async () => {
      const response = await withHeader(
        request(app.getHttpServer()).post('/auth/logout'),
        authorization,
      ).send({ refreshToken: tokens.refreshToken });

      expect(response.status).toBe(204);
    });

    it('should serve GET and HEAD /.well-known/jwks.json', async () => {
      const get = await withHeader(
        request(app.getHttpServer()).get('/.well-known/jwks.json'),
        authorization,
      );
      const head = await withHeader(
        request(app.getHttpServer()).head('/.well-known/jwks.json'),
        authorization,
      );

      expect(get.status).toBe(200);
      expect((get.body as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
      expect(head.status).toBe(200);
    });

    it('should serve /health', async () => {
      const response = await withHeader(request(app.getHttpServer()).get('/health'), authorization);

      expect(response.status).toBe(200);
    });

    it('should serve /docs and /docs-json', async () => {
      const docs = await withHeader(request(app.getHttpServer()).get('/docs'), authorization);
      const json = await withHeader(request(app.getHttpServer()).get('/docs-json'), authorization);

      expect(docs.status).toBe(200);
      expect(json.status).toBe(200);
      expect(Object.keys((json.body as { paths: object }).paths)).toContain('/users/me');
    });
  });
});
