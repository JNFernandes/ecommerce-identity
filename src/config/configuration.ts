/** PostgreSQL connection settings (`DATABASE_*`). */
export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /**
   * Apply pending TypeORM migrations when the app starts, before it serves requests
   * (`DATABASE_MIGRATIONS_RUN`, on unless "false").
   */
  migrationsRun: boolean;
}

/** Kafka producer settings (`KAFKA_*`). */
export interface KafkaConfig {
  /** Broker addresses (`KAFKA_BROKERS`, comma-separated). */
  brokers: string[];
  /** Kafka client id (`KAFKA_CLIENT_ID`, default `ecommerce-identity`). */
  clientId: string;
  /**
   * Timeout in ms for opening a broker connection (`KAFKA_CONNECTION_TIMEOUT_MS`, default 1000).
   * With `producerRetries`, it bounds how long a publish to an unreachable broker can take.
   */
  connectionTimeoutMs: number;
  /**
   * Retries for connecting and publishing before the producer gives up
   * (`KAFKA_PRODUCER_RETRIES`, default 1).
   */
  producerRetries: number;
}

/**
 * Access token settings used by later stories. Issuer, audience and key path have no default:
 * they are deployment values and stay unset until configured.
 */
export interface JwtConfig {
  /** `iss` claim (`JWT_ISSUER`). */
  issuer: string | undefined;
  /** `aud` claim (`JWT_AUDIENCE`). */
  audience: string | undefined;
  /** Access token lifetime in seconds (`JWT_ACCESS_TTL_SECONDS`, default 900 = 15 minutes). */
  accessTtlSeconds: number;
  /** Path of the mounted RS256 private key (`JWT_PRIVATE_KEY_PATH`). Never committed. */
  privateKeyPath: string | undefined;
  /** Refresh token lifetime in seconds (`JWT_REFRESH_TTL_SECONDS`, default 604800 = 7 days). */
  refreshTtlSeconds: number;
  /**
   * Paths of retired RS256 public keys still published for verification
   * (`JWT_RETIRED_PUBLIC_KEY_PATHS`, comma-separated, in order). Empty or unset: none.
   */
  retiredPublicKeyPaths: string[];
  /**
   * Absolute session lifetime in seconds, counted from the login that started a refresh token
   * family (`JWT_SESSION_MAX_SECONDS`, default 2592000 = 30 days). Must be at least
   * `refreshTtlSeconds`; startup fails otherwise.
   */
  sessionMaxSeconds: number;
}

/** Key set endpoint settings (`JWKS_*`). */
export interface JwksConfig {
  /**
   * Raw `JWKS_CACHE_SECONDS` value (default 300 when unset). Kept raw so an invalid value fails
   * startup through `parseNonNegativeInteger` instead of silently falling back.
   */
  cacheSeconds: string | undefined;
}

/** argon2id password hashing parameters (`ARGON2_*`). */
export interface Argon2Config {
  /** Memory cost in KiB (`ARGON2_MEMORY_COST_KIB`, default 65536 = 64 MiB). */
  memoryCostKib: number;
  /** Number of iterations (`ARGON2_TIME_COST`, default 3). */
  timeCost: number;
  /** Degree of parallelism (`ARGON2_PARALLELISM`, default 4). */
  parallelism: number;
}

/** Limit for one named throttler: at most `limit` requests per client IP within `ttlMs`. */
export interface RateLimitRule {
  /** Maximum requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  ttlMs: number;
}

/** Per-route rate limits (`RATE_LIMIT_*`). */
export interface RateLimitConfig {
  /**
   * `POST /auth/register` (`RATE_LIMIT_REGISTER_LIMIT`, default 5;
   * `RATE_LIMIT_REGISTER_TTL_MS`, default 60000).
   */
  register: RateLimitRule;
  /**
   * `POST /auth/login`, applied per client IP and per normalized email
   * (`RATE_LIMIT_LOGIN_LIMIT`, default 10; `RATE_LIMIT_LOGIN_TTL_MS`, default 60000).
   */
  login: RateLimitRule;
}

/** Cross-origin settings. */
export interface CorsConfig {
  /**
   * Origins allowed to call the API from a browser (`CORS_ALLOWED_ORIGINS`, comma-separated,
   * matched exactly). Empty or unset: no cross-origin access.
   */
  allowedOrigins: string[];
}

/** The whole service configuration. */
export interface AppConfig {
  /** HTTP port (`PORT`, default 3001; 3000 is Orders, 8080 is Kafka UI). */
  port: number;
  cors: CorsConfig;
  database: DatabaseConfig;
  kafka: KafkaConfig;
  jwt: JwtConfig;
  jwks: JwksConfig;
  argon2: Argon2Config;
  rateLimit: RateLimitConfig;
}

/** Default HTTP port. */
export const DEFAULT_PORT = 3001;

/**
 * Splits a comma-separated list, trimming whitespace and dropping empty entries, so an empty or
 * unset value yields an empty list.
 */
export function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Reads an optional string, treating an empty value as unset. */
function optional(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Parses an integer environment variable, falling back to `fallback` when unset or invalid. */
export function parseInteger(raw: string | undefined, fallback: number): number {
  const value = optional(raw);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Parses a strict non-negative integer setting: unset or empty yields `fallback`; anything else
 * that is not a plain non-negative integer is rejected.
 *
 * @param raw The raw environment value.
 * @param fallback Value used when `raw` is unset or empty.
 * @param name The variable name, used in the error message.
 * @throws Error `"<name> must be a non-negative integer"` for a negative, decimal or non-numeric value.
 */
export function parseNonNegativeInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  const value = optional(raw);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

/** Default absolute session lifetime: 30 days. */
export const DEFAULT_SESSION_MAX_SECONDS = 2592000;

/**
 * Reads the JWT settings and checks that the session limit is not shorter than one refresh token
 * lifetime.
 *
 * @throws Error when `JWT_SESSION_MAX_SECONDS` is invalid or smaller than `JWT_REFRESH_TTL_SECONDS`.
 */
function readJwtConfig(): JwtConfig {
  const refreshTtlSeconds = parseInteger(process.env.JWT_REFRESH_TTL_SECONDS, 604800);
  const sessionMaxSeconds = parseNonNegativeInteger(
    process.env.JWT_SESSION_MAX_SECONDS,
    DEFAULT_SESSION_MAX_SECONDS,
    'JWT_SESSION_MAX_SECONDS',
  );
  if (sessionMaxSeconds < refreshTtlSeconds) {
    throw new Error('JWT_SESSION_MAX_SECONDS must be >= JWT_REFRESH_TTL_SECONDS');
  }
  return {
    issuer: optional(process.env.JWT_ISSUER),
    audience: optional(process.env.JWT_AUDIENCE),
    accessTtlSeconds: parseInteger(process.env.JWT_ACCESS_TTL_SECONDS, 900),
    privateKeyPath: optional(process.env.JWT_PRIVATE_KEY_PATH),
    refreshTtlSeconds,
    retiredPublicKeyPaths: parseList(process.env.JWT_RETIRED_PUBLIC_KEY_PATHS),
    sessionMaxSeconds,
  };
}

/** Reads the whole configuration from environment variables, with local-development defaults. */
export default (): AppConfig => ({
  port: parseInteger(process.env.PORT, DEFAULT_PORT),
  cors: {
    allowedOrigins: parseList(process.env.CORS_ALLOWED_ORIGINS),
  },
  database: {
    host: optional(process.env.DATABASE_HOST) ?? 'localhost',
    port: parseInteger(process.env.DATABASE_PORT, 5435),
    username: optional(process.env.DATABASE_USER) ?? 'identity_user',
    password: optional(process.env.DATABASE_PASSWORD) ?? 'identity_pass',
    database: optional(process.env.DATABASE_NAME) ?? 'identity',
    migrationsRun: process.env.DATABASE_MIGRATIONS_RUN !== 'false',
  },
  kafka: {
    brokers: parseList(process.env.KAFKA_BROKERS ?? 'localhost:9092'),
    clientId: optional(process.env.KAFKA_CLIENT_ID) ?? 'ecommerce-identity',
    connectionTimeoutMs: parseInteger(process.env.KAFKA_CONNECTION_TIMEOUT_MS, 1000),
    producerRetries: parseInteger(process.env.KAFKA_PRODUCER_RETRIES, 1),
  },
  jwt: readJwtConfig(),
  jwks: {
    cacheSeconds: optional(process.env.JWKS_CACHE_SECONDS),
  },
  argon2: {
    memoryCostKib: parseInteger(process.env.ARGON2_MEMORY_COST_KIB, 65536),
    timeCost: parseInteger(process.env.ARGON2_TIME_COST, 3),
    parallelism: parseInteger(process.env.ARGON2_PARALLELISM, 4),
  },
  rateLimit: {
    register: {
      limit: parseInteger(process.env.RATE_LIMIT_REGISTER_LIMIT, 5),
      ttlMs: parseInteger(process.env.RATE_LIMIT_REGISTER_TTL_MS, 60000),
    },
    login: {
      limit: parseInteger(process.env.RATE_LIMIT_LOGIN_LIMIT, 10),
      ttlMs: parseInteger(process.env.RATE_LIMIT_LOGIN_TTL_MS, 60000),
    },
  },
});
