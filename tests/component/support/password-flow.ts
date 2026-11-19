import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

/** A new password that satisfies the registration policy. */
export const NEW_PASSWORD = 'a-brand-new-passphrase';

/** Sends `POST /users/me/password` with the given bearer token (if any) and body. */
export function postChangePassword(
  app: INestApplication,
  accessToken: string | undefined,
  body: unknown,
): request.Test {
  const req = request(app.getHttpServer()).post('/users/me/password');
  if (accessToken !== undefined) {
    req.set('Authorization', `Bearer ${accessToken}`);
  }
  return req.send(body as object);
}

/** What a password change may touch: the stored hash and the user's token rows. */
export interface PasswordState {
  passwordHash: string;
  updatedAt: Date;
  tokens: { id: string; revokedAt: Date | null }[];
}

/** Reads the stored hash and every refresh token row of a user, for "nothing changed" checks. */
export async function passwordState(
  dataSource: DataSource,
  userId: string,
): Promise<PasswordState> {
  const users: { passwordHash: string; updatedAt: Date }[] = await dataSource.query(
    'SELECT "passwordHash", "updatedAt" FROM "users" WHERE "id" = $1',
    [userId],
  );
  const tokens: { id: string; revokedAt: Date | null }[] = await dataSource.query(
    'SELECT "id", "revokedAt" FROM "refresh_tokens" WHERE "userId" = $1 ORDER BY "id"',
    [userId],
  );
  return { ...users[0], tokens };
}
