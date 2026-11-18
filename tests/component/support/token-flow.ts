import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { Email } from '../../../src/domain/email.value-object';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { UserRepository } from '../../../src/repositories/user.repository';
import { PasswordHasher } from '../../../src/services/ports/password-hasher';

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
  return { userId, customerId, tokens: await login(app, email) };
}

/** An admin inserted for a test, with the tokens of its first login. */
export interface LoggedInAdmin {
  userId: string;
  tokens: TokenPair;
}

/** Logs in with {@link FLOW_PASSWORD}; fails the test when the login does not succeed. */
function login(app: INestApplication, email: string): Promise<TokenPair> {
  return loginAs(app, email, FLOW_PASSWORD);
}

/**
 * Logs in with the given credentials (e.g. the seeded admin's); fails the test when the login does
 * not succeed.
 */
export async function loginAs(
  app: INestApplication,
  email: string,
  password: string,
): Promise<TokenPair> {
  const response = await request(app.getHttpServer()).post('/auth/login').send({ email, password });
  if (response.status !== 200) {
    throw new Error(`login failed with ${response.status}`);
  }
  return response.body as TokenPair;
}

/**
 * Inserts an `ADMIN` user (no `customerId`) through `UserRepository`, then logs it in normally.
 * Used by the US-05 guard tests, which need an admin without configuring the startup seed; tests
 * of the admin endpoints use the real seed instead (`useAdminSeed` + `loginAs`).
 */
export async function insertAdminAndLogin(
  app: INestApplication,
  email: string,
): Promise<LoggedInAdmin> {
  const now = new Date();
  const admin = User.restore({
    id: randomUUID(),
    customerId: null,
    email: Email.create(email),
    name: UserName.create('Admin'),
    passwordHash: await app.get(PasswordHasher).hash(FLOW_PASSWORD),
    roles: [Role.ADMIN],
    status: UserStatus.ACTIVE,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  });
  await app.get(UserRepository).save(admin);
  return { userId: admin.id, tokens: await login(app, email) };
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
