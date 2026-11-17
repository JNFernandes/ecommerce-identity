import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestApp,
  startPostgres,
  tempKeyDir,
  useActiveKey,
  useJwksCacheSeconds,
  useUnreachableKafka,
  writeTestKeyPair,
} from './support/test-app';

jest.setTimeout(180_000);

const PATH = '/.well-known/jwks.json';

/** Starts an app with the current settings, runs `use` against it and closes it. */
async function withApp<T>(use: (app: INestApplication) => Promise<T>): Promise<T> {
  const app = await createTestApp();
  try {
    return await use(app);
  } finally {
    await app.close();
  }
}

/** US-03 / US-4: clients cache the key set cheaply. */
describe('JWKS caching (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
  });

  afterEach(() => {
    useJwksCacheSeconds(undefined);
  });

  afterAll(async () => {
    await container?.stop();
    process.env = savedEnv;
  });

  it.each<[string | undefined, string]>([
    [undefined, 'public, max-age=300'],
    ['60', 'public, max-age=60'],
    ['0', 'public, max-age=0'],
  ])('should send Cache-Control for JWKS_CACHE_SECONDS=%p', async (raw, expected) => {
    useJwksCacheSeconds(raw);

    const response = await withApp((app) => request(app.getHttpServer()).get(PATH).expect(200));

    expect(response.headers['cache-control']).toBe(expected);
  });

  describe('revalidation', () => {
    let app: INestApplication;
    let etag: string;

    beforeAll(async () => {
      app = await createTestApp();
      const response = await request(app.getHttpServer()).get(PATH).expect(200);
      etag = response.headers.etag as string;
    });

    afterAll(async () => {
      await app?.close();
    });

    it.each([
      ['the current ETag', (current: string): string => current],
      ['the wildcard', (): string => '*'],
      ['a list containing it', (current: string): string => `"stale", ${current}`],
    ])('should answer 304 with no body and the same headers for %s', async (_case, header) => {
      const response = await request(app.getHttpServer())
        .get(PATH)
        .set('If-None-Match', header(etag))
        .expect(304);

      expect(response.text ?? '').toBe('');
      expect(response.headers.etag).toBe(etag);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
    });

    it('should answer 200 with the body for a stale ETag', async () => {
      const response = await request(app.getHttpServer())
        .get(PATH)
        .set('If-None-Match', '"stale"')
        .expect(200);

      expect((response.body as { keys: unknown[] }).keys).toHaveLength(1);
      expect(response.headers.etag).toBe(etag);
    });

    it('should never throttle, even above the login limit', async () => {
      const server = app.getHttpServer();
      const statuses: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        statuses.push((await request(server).get(PATH)).status);
      }

      expect(statuses.every((status) => status === 200)).toBe(true);
    });
  });

  it('should give the same ETag for the same keys across instances and a new one for new keys', async () => {
    const dir = tempKeyDir();
    const fetchEtag = (): Promise<string> =>
      withApp(
        async (app) =>
          (await request(app.getHttpServer()).get(PATH).expect(200)).headers.etag as string,
      );
    useActiveKey(writeTestKeyPair(dir, 'a'));
    const first = await fetchEtag();
    const second = await fetchEtag();

    useActiveKey(writeTestKeyPair(dir, 'b'));
    const third = await fetchEtag();

    expect(second).toBe(first);
    expect(third).not.toBe(first);
  });
});
