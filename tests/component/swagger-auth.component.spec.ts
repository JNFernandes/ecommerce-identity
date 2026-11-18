import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';

jest.setTimeout(180_000);

interface Operation {
  security?: Record<string, string[]>[];
  responses: Record<string, unknown>;
  'x-roles'?: string[];
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes?: Record<string, { type: string; scheme?: string }> };
}

/** The OpenAPI document shows the bearer scheme and roles of protected routes (US5). */
describe('Swagger authentication docs (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let doc: OpenApiDocument;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    app = await createTestApp(undefined, [], { swagger: true });
    doc = (await request(app.getHttpServer()).get('/docs-json').expect(200))
      .body as OpenApiDocument;
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should declare a bearer security scheme', () => {
    expect(doc.components.securitySchemes?.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('should document GET /users/me as bearer-protected for CUSTOMER and ADMIN', () => {
    const operation = doc.paths['/users/me'].get;

    expect(operation.security).toEqual([{ bearer: [] }]);
    expect(operation['x-roles']).toEqual(['CUSTOMER', 'ADMIN']);
    expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['200', '401', '403']));
  });

  it.each([
    ['/auth/register', 'post'],
    ['/auth/login', 'post'],
    ['/health', 'get'],
  ])('should leave the public route %s without security', (path, method) => {
    const operation = doc.paths[path][method];

    expect(operation.security).toBeUndefined();
    expect(operation['x-roles']).toBeUndefined();
  });
});
