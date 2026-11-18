import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

/** Password used for every account created by the token flow helpers. */
export const FLOW_PASSWORD = 'correct-horse-battery';

/** Body of a successful login or refresh. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

/** A registered customer with the tokens of its first login. */
export interface LoggedInCustomer {
  userId: string;
  customerId: string;
  tokens: TokenPair;
}

/** A stored `refresh_tokens` row. */
export interface RefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

/** SHA-256 hex digest of a token value, as the service stores it. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Registers a customer and logs it in; fails the test when either step does not succeed. */
export async function registerAndLogin(
  app: INestApplication,
  email: string,
): Promise<LoggedInCustomer> {
  const registered = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, name: 'Ana', password: FLOW_PASSWORD });
  if (registered.status !== 201) {
    throw new Error(`register failed with ${registered.status}`);
  }
  const { id: userId, customerId } = registered.body as { id: string; customerId: string };
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: FLOW_PASSWORD });
  if (login.status !== 200) {
    throw new Error(`login failed with ${login.status}`);
  }
  return { userId, customerId, tokens: login.body as TokenPair };
}

/** Sends `POST /auth/refresh` with the given token. */
export function postRefresh(app: INestApplication, refreshToken: unknown): request.Test {
  return request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken });
}

/** Sends `POST /auth/logout` with the given token. */
export function postLogout(app: INestApplication, refreshToken: unknown): request.Test {
  return request(app.getHttpServer()).post('/auth/logout').send({ refreshToken });
}

/** Reads the stored row of a token value, or `undefined`. */
export async function rowOf(
  dataSource: DataSource,
  refreshToken: string,
): Promise<RefreshTokenRow | undefined> {
  const rows: RefreshTokenRow[] = await dataSource.query(
    `SELECT * FROM "refresh_tokens" WHERE "tokenHash" = $1`,
    [sha256(refreshToken)],
  );
  return rows[0];
}

/** Reads every row of a family, oldest first. */
export async function familyRows(
  dataSource: DataSource,
  familyId: string,
): Promise<RefreshTokenRow[]> {
  return dataSource.query(
    `SELECT * FROM "refresh_tokens" WHERE "familyId" = $1 ORDER BY "createdAt", "id"`,
    [familyId],
  );
}
