import { Abstract, INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync, KeyObject } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { AddressInfo, createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AppModule } from '../../../src/app.module';
import { configureApp } from '../../../src/app.setup';

/** Returns a local port with nothing listening on it, so a client pointed there fails fast. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** `iss` used by component tests. */
export const TEST_JWT_ISSUER = 'ecommerce-identity-test';

/** `aud` used by component tests. */
export const TEST_JWT_AUDIENCE = 'ecommerce-test';

/** A test RSA key pair written to disk, with the paths the app settings point at. */
export interface TestKeyPair {
  /** The public key, so tests can verify issued tokens. */
  publicKey: KeyObject;
  /** PKCS#8 private key file (`<name>-private.pem`). */
  privateKeyPath: string;
  /** SPKI public key file (`<name>-public.pem`). */
  publicKeyPath: string;
}

/** A new empty temp directory for key files. */
export function tempKeyDir(): string {
  return mkdtempSync(join(tmpdir(), 'identity-test-key-'));
}

/**
 * Generates an RSA key pair in memory and writes `<name>-private.pem` (PKCS#8, owner-only) and
 * `<name>-public.pem` (SPKI) to `dir`.
 */
export function writeTestKeyPair(dir: string, name: string, modulusLength = 2048): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  const privateKeyPath = join(dir, `${name}-private.pem`);
  const publicKeyPath = join(dir, `${name}-public.pem`);
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  return { publicKey, privateKeyPath, publicKeyPath };
}

/** Points `JWT_PRIVATE_KEY_PATH` at the pair's private key and sets the test issuer and audience. */
export function useActiveKey(pair: TestKeyPair): void {
  process.env.JWT_PRIVATE_KEY_PATH = pair.privateKeyPath;
  process.env.JWT_ISSUER = TEST_JWT_ISSUER;
  process.env.JWT_AUDIENCE = TEST_JWT_AUDIENCE;
}

/**
 * Sets `JWT_RETIRED_PUBLIC_KEY_PATHS` to the paths joined by commas, in order; `undefined` unsets
 * it.
 */
export function useRetiredPublicKeys(paths: readonly string[] | undefined): void {
  if (paths === undefined) {
    delete process.env.JWT_RETIRED_PUBLIC_KEY_PATHS;
  } else {
    process.env.JWT_RETIRED_PUBLIC_KEY_PATHS = paths.join(',');
  }
}

/** Sets `JWKS_CACHE_SECONDS` to the raw value; `undefined` unsets it (default 300). */
export function useJwksCacheSeconds(raw: string | undefined): void {
  if (raw === undefined) {
    delete process.env.JWKS_CACHE_SECONDS;
  } else {
    process.env.JWKS_CACHE_SECONDS = raw;
  }
}

/**
 * Writes a fresh 2048-bit key pair to a new temp dir and makes it the active key (see
 * {@link useActiveKey}). Each call replaces the previous key.
 */
export function useTestSigningKey(): TestKeyPair {
  const pair = writeTestKeyPair(tempKeyDir(), 'active');
  useActiveKey(pair);
  return pair;
}

/**
 * Starts a PostgreSQL container and points the app's `DATABASE_*` settings at it (migrations run
 * on startup). Also sets low argon2 parameters so registrations stay fast, and a temporary signing
 * key (see {@link useTestSigningKey}).
 */
export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_HOST = container.getHost();
  process.env.DATABASE_PORT = String(container.getPort());
  process.env.DATABASE_NAME = container.getDatabase();
  process.env.DATABASE_USER = container.getUsername();
  process.env.DATABASE_PASSWORD = container.getPassword();
  process.env.DATABASE_MIGRATIONS_RUN = 'true';
  process.env.ARGON2_MEMORY_COST_KIB = '1024';
  process.env.ARGON2_TIME_COST = '2';
  process.env.ARGON2_PARALLELISM = '1';
  useTestSigningKey();
  return container;
}

/**
 * Points Kafka at a closed local port with no retries and a short connection timeout, so every
 * publish fails within a fraction of a second (never the developer's `localhost:9092`).
 */
export async function useUnreachableKafka(): Promise<void> {
  process.env.KAFKA_BROKERS = `127.0.0.1:${await closedPort()}`;
  process.env.KAFKA_PRODUCER_RETRIES = '0';
  process.env.KAFKA_CONNECTION_TIMEOUT_MS = '200';
}

/** A provider replaced in the test app, e.g. the `Clock`. */
export interface ProviderOverride {
  /** The injection token to replace. */
  provide: Abstract<unknown>;
  /** The value used instead. */
  useValue: unknown;
}

/**
 * Builds and initializes the full application exactly as `main.ts` configures it.
 *
 * @param logger Optional logger capturing the app's output.
 * @param overrides Providers to replace (e.g. a controllable `Clock`).
 */
export async function createTestApp(
  logger?: LoggerService,
  overrides: readonly ProviderOverride[] = [],
): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  for (const { provide, useValue } of overrides) {
    builder.overrideProvider(provide).useValue(useValue);
  }
  const moduleRef = await builder.compile();
  if (logger !== undefined) {
    moduleRef.useLogger(logger);
  }
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}
