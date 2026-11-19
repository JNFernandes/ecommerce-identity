import { INestApplication } from '@nestjs/common';
import request from 'supertest';

/** One `GET /audit` item as returned. */
export interface AuditItem {
  id: string;
  actorId: string;
  action: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  createdAt: string;
}

/** One `GET /audit` page as returned. */
export interface AuditPage {
  items: AuditItem[];
  total: number;
  limit: number;
  offset: number;
}

/** Password used for every user created by these helpers. */
export const AUDIT_FLOW_PASSWORD = 'audit-flow-pass-123';

/** Calls `GET /audit` with the token and query (an object or a raw query string). */
export function getAudit(
  app: INestApplication,
  token: string | undefined,
  query: Record<string, string | number> | string = {},
): request.Test {
  const test = request(app.getHttpServer()).get('/audit').query(query);
  return token === undefined ? test : test.set('Authorization', `Bearer ${token}`);
}

/** Calls `GET /audit`, expects 200 and returns the page. */
export async function listAudit(
  app: INestApplication,
  token: string,
  query: Record<string, string | number> | string = {},
): Promise<AuditPage> {
  const response = await getAudit(app, token, query).expect(200);
  return response.body as AuditPage;
}

/** Creates a user through `POST /users` as the admin and returns its id. */
export async function createUser(
  app: INestApplication,
  adminToken: string,
  email: string,
  roles: string[],
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email, name: 'Audit User', password: AUDIT_FLOW_PASSWORD, roles })
    .expect(201);
  return (response.body as { id: string }).id;
}

/** Replaces a user's roles through `PUT /users/{id}/roles`; expects 200. */
export async function changeRoles(
  app: INestApplication,
  adminToken: string,
  id: string,
  roles: string[],
): Promise<void> {
  await request(app.getHttpServer())
    .put(`/users/${id}/roles`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ roles })
    .expect(200);
}

/** Sets a user's status through `PATCH /users/{id}/status`; expects 200. */
export async function changeStatus(
  app: INestApplication,
  adminToken: string,
  id: string,
  status: 'ACTIVE' | 'DISABLED',
): Promise<void> {
  await request(app.getHttpServer())
    .patch(`/users/${id}/status`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status })
    .expect(200);
}
