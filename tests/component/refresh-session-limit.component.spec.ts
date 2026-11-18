import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Clock } from '../../src/services/ports/clock';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import { postRefresh, registerAndLogin, rowOf, TokenPair } from './support/token-flow';

jest.setTimeout(180_000);

/** A clock the test moves by hand. */
class ManualClock extends Clock {
  current = new Date();

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Moves the clock to `seconds` after `from`. */
  setTo(from: Date, seconds: number): void {
    this.current = new Date(from.getTime() + seconds * 1000);
  }
}

describe('absolute session limit (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
  });

  afterAll(async () => {
    await container?.stop();
    process.env = savedEnv;
  });

  describe('with a 60 second session and refresh lifetime', () => {
    const clock = new ManualClock();
    let app: INestApplication;
    let dataSource: DataSource;

    beforeAll(async () => {
      process.env.JWT_SESSION_MAX_SECONDS = '60';
      process.env.JWT_REFRESH_TTL_SECONDS = '60';
      app = await createTestApp(undefined, [{ provide: Clock, useValue: clock }]);
      dataSource = app.get(DataSource);
    });

    afterAll(async () => {
      await app?.close();
    });

    it('should cap every new refresh token at the session end and refuse after it', async () => {
      const loginAt = new Date();
      clock.setTo(loginAt, 0);
      const { tokens } = await registerAndLogin(app, 'session@example.com');

      clock.setTo(loginAt, 30);
      const refreshed = await postRefresh(app, tokens.refreshToken);
      expect(refreshed.status).toBe(200);
      const next = (refreshed.body as TokenPair).refreshToken;
      expect((await rowOf(dataSource, next))?.expiresAt).toEqual(
        new Date(loginAt.getTime() + 60_000),
      );

      clock.setTo(loginAt, 61);
      expect((await postRefresh(app, next)).status).toBe(401);
    });
  });

  it('should fail startup when the session limit is shorter than the refresh lifetime', async () => {
    process.env.JWT_SESSION_MAX_SECONDS = '59';
    process.env.JWT_REFRESH_TTL_SECONDS = '60';

    await expect(createTestApp()).rejects.toThrow(
      'JWT_SESSION_MAX_SECONDS must be >= JWT_REFRESH_TTL_SECONDS',
    );
  });
});
