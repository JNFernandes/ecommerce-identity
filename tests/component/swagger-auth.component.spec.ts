import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';

jest.setTimeout(180_000);

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema: Record<string, unknown>;
}

interface Operation {
  security?: Record<string, string[]>[];
  responses: Record<string, unknown>;
  parameters?: Parameter[];
  'x-roles'?: string[];
  'x-public'?: boolean;
  description?: string;
}

interface Schema {
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
  components: {
    securitySchemes?: Record<string, { type: string; scheme?: string }>;
    schemas: Record<string, Schema>;
  };
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

  it.each(['/users', '/users/{id}'])(
    'should document GET %s as bearer-protected for ADMIN only, with 400, 401 and 403',
    (path) => {
      const operation = doc.paths[path].get;

      expect(operation.security).toEqual([{ bearer: [] }]);
      expect(operation['x-roles']).toEqual(['ADMIN']);
      expect(Object.keys(operation.responses)).toEqual(
        expect.arrayContaining(['200', '400', '401', '403']),
      );
    },
  );

  it('should document the 404 and the uuid path parameter of GET /users/{id}', () => {
    const operation = doc.paths['/users/{id}'].get;

    expect(Object.keys(operation.responses)).toContain('404');
    expect(operation.parameters).toContainEqual(
      expect.objectContaining({
        name: 'id',
        in: 'path',
        schema: expect.objectContaining({ format: 'uuid' }),
      }),
    );
  });

  it('should document PATCH /users/{id}/status as ADMIN-only with its body and responses', () => {
    const operation = doc.paths['/users/{id}/status'].patch as Operation & {
      requestBody?: { content: Record<string, { schema: { $ref?: string } }> };
      responses: Record<string, { content?: Record<string, { schema: { $ref?: string } }> }>;
    };

    expect(operation.security).toEqual([{ bearer: [] }]);
    expect(operation['x-roles']).toEqual(['ADMIN']);
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404', '409']),
    );
    expect(operation.responses['200'].content?.['application/json'].schema.$ref).toBe(
      '#/components/schemas/UserSummaryResponseDto',
    );
    expect(operation.requestBody?.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ChangeUserStatusDto',
    );
    expect(operation.parameters).toContainEqual(
      expect.objectContaining({
        name: 'id',
        in: 'path',
        schema: expect.objectContaining({ format: 'uuid' }),
      }),
    );
    const body = doc.components.schemas.ChangeUserStatusDto;
    expect(Object.keys(body.properties)).toEqual(['status']);
    expect(body.required).toEqual(['status']);
    expect(body.properties.status).toMatchObject({ enum: ['ACTIVE', 'DISABLED'] });
  });

  it('should document the GET /users query parameters with their enums and bounds', () => {
    const parameters = new Map(
      (doc.paths['/users'].get.parameters ?? []).map((parameter) => [parameter.name, parameter]),
    );

    expect([...parameters.keys()].sort()).toEqual(['email', 'limit', 'offset', 'role', 'status']);
    for (const parameter of parameters.values()) {
      expect(parameter.in).toBe('query');
      expect(parameter.required).toBe(false);
    }
    expect(parameters.get('limit')?.schema).toMatchObject({
      minimum: 1,
      maximum: 100,
      default: 20,
    });
    expect(parameters.get('offset')?.schema).toMatchObject({ minimum: 0, default: 0 });
    expect(parameters.get('role')?.schema).toMatchObject({ enum: ['CUSTOMER', 'ADMIN'] });
    expect(parameters.get('status')?.schema).toMatchObject({ enum: ['ACTIVE', 'DISABLED'] });
    expect(parameters.get('email')?.schema).toMatchObject({ maxLength: 254 });
  });

  it('should document the page and item schemas without any password field', () => {
    const page = doc.components.schemas.UserPageResponseDto;
    const item = doc.components.schemas.UserSummaryResponseDto;

    expect(Object.keys(page.properties).sort()).toEqual(['items', 'limit', 'offset', 'total']);
    expect(Object.keys(item.properties).sort()).toEqual(
      ['createdAt', 'customerId', 'email', 'id', 'lastLoginAt', 'name', 'roles', 'status'].sort(),
    );
    expect(item.required).not.toContain('customerId');
    expect(item.properties.lastLoginAt).toMatchObject({ nullable: true });
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

  it('should state the access of every operation and document at least one non-2xx response', () => {
    const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, operation]) => ({
        route: `${method} ${path}`,
        operation,
      })),
    );

    expect(operations.length).toBeGreaterThan(0);
    for (const { route, operation } of operations) {
      const roles = operation['x-roles'];
      if (roles === undefined) {
        expect({ route, public: operation['x-public'] }).toEqual({ route, public: true });
        expect(operation.description).toMatch(/^\*\*Access:\*\* public/);
      } else {
        expect({ route, public: operation['x-public'] }).toEqual({ route, public: undefined });
        expect(operation.description?.startsWith(`**Roles:** ${roles.join(', ')} `)).toBe(true);
      }
      const errors = Object.keys(operation.responses).filter((status) => !status.startsWith('2'));
      expect({ route, hasErrors: errors.length > 0 }).toEqual({ route, hasErrors: true });
    }
  });
});
