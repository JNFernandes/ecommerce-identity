import { Abstract, INestApplication, LoggerService, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync, KeyObject } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { AddressInfo, createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../src/app.module';
import { configureApp } from '../../../src/app.setup';
import { configureSwagger } from '../../../src/app.swagger';

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
 * Creates a new, empty database in the container and points `DATABASE_NAME` at it, so the next app
 * start migrates and uses an empty schema (e.g. to run the admin seed again from scratch).
 *
 * @param container The running PostgreSQL container.
 * @param name The new database name (unique per container).
 */
export async function useNewDatabase(
  container: StartedPostgreSqlContainer,
  name: string,
): Promise<void> {
  const admin = await new DataSource({
    type: 'postgres',
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
  }).initialize();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.destroy();
  }
  process.env.DATABASE_NAME = name;
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

/** Values of the admin seed variables (see {@link useAdminSeed}). */
export interface AdminSeedValues {
  /** `ADMIN_EMAIL`. */
  email: string;
  /** `ADMIN_PASSWORD`. */
  password: string;
  /** `ADMIN_NAME`; unset when omitted. */
  name?: string;
}

/**
 * Sets `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `ADMIN_NAME` for the next app start; `undefined` unsets
 * all three, so the seed is not configured.
 */
export function useAdminSeed(values: AdminSeedValues | undefined): void {
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_NAME;
  if (values === undefined) {
    return;
  }
  process.env.ADMIN_EMAIL = values.email;
  process.env.ADMIN_PASSWORD = values.password;
  if (values.name !== undefined) {
    process.env.ADMIN_NAME = values.name;
  }
}

/** A provider replaced in the test app, e.g. the `Clock`. */
export interface ProviderOverride {
  /** The injection token to replace. */
  provide: Abstract<unknown>;
  /** The value used instead. */
  useValue: unknown;
}

/** Extra options of {@link createTestApp}. */
export interface TestAppOptions {
  /** Test-only controllers mounted next to the app's own (e.g. a role probe). Never shipped. */
  extraControllers?: readonly Type[];
  /** Mount Swagger at `/docs` and `/docs-json`, as `main.ts` does. Off by default. */
  swagger?: boolean;
}

/**
 * Builds and initializes the full application exactly as `main.ts` configures it.
 *
 * @param logger Optional logger capturing the app's output.
 * @param overrides Providers to replace (e.g. a controllable `Clock`).
 * @param options Test-only additions such as extra controllers.
 */
export async function createTestApp(
  logger?: LoggerService,
  overrides: readonly ProviderOverride[] = [],
  options: TestAppOptions = {},
): Promise<INestApplication> {
  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: [...(options.extraControllers ?? [])],
  });
  for (const { provide, useValue } of overrides) {
    builder.overrideProvider(provide).useValue(useValue);
  }
  const moduleRef = await builder.compile();
  if (logger !== undefined) {
    moduleRef.useLogger(logger);
  }
  const app = moduleRef.createNestApplication();
  configureApp(app);
  if (options.swagger === true) {
    configureSwagger(app);
  }
  await app.init();
  return app;
}
