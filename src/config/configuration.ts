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
  argon2: Argon2Config;
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
  jwt: {
    issuer: optional(process.env.JWT_ISSUER),
    audience: optional(process.env.JWT_AUDIENCE),
    accessTtlSeconds: parseInteger(process.env.JWT_ACCESS_TTL_SECONDS, 900),
    privateKeyPath: optional(process.env.JWT_PRIVATE_KEY_PATH),
  },
  argon2: {
    memoryCostKib: parseInteger(process.env.ARGON2_MEMORY_COST_KIB, 65536),
    timeCost: parseInteger(process.env.ARGON2_TIME_COST, 3),
    parallelism: parseInteger(process.env.ARGON2_PARALLELISM, 4),
  },
});
