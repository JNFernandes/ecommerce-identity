import configuration, {
  parseInteger,
  parseList,
  parseNonNegativeInteger,
} from '../../../src/config/configuration';

const VARIABLES = [
  'PORT',
  'CORS_ALLOWED_ORIGINS',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  'DATABASE_MIGRATIONS_RUN',
  'KAFKA_BROKERS',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'JWT_ACCESS_TTL_SECONDS',
  'JWT_PRIVATE_KEY_PATH',
  'JWT_REFRESH_TTL_SECONDS',
  'JWT_RETIRED_PUBLIC_KEY_PATHS',
  'JWT_SESSION_MAX_SECONDS',
  'JWKS_CACHE_SECONDS',
  'ARGON2_MEMORY_COST_KIB',
  'ARGON2_TIME_COST',
  'ARGON2_PARALLELISM',
  'RATE_LIMIT_REGISTER_LIMIT',
  'RATE_LIMIT_REGISTER_TTL_MS',
  'RATE_LIMIT_LOGIN_LIMIT',
  'RATE_LIMIT_LOGIN_TTL_MS',
  'RATE_LIMIT_REFRESH_LIMIT',
  'RATE_LIMIT_REFRESH_TTL_MS',
  'RATE_LIMIT_LOGOUT_LIMIT',
  'RATE_LIMIT_LOGOUT_TTL_MS',
];

describe('configuration', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of VARIABLES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of VARIABLES) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  it('should default to the local ecommerce-infra settings when no variable is set', () => {
    const config = configuration();

    expect(config.port).toBe(3001);
    expect(config.cors.allowedOrigins).toEqual([]);
    expect(config.database).toEqual({
      host: 'localhost',
      port: 5435,
      username: 'identity_user',
      password: 'identity_pass',
      database: 'identity',
      migrationsRun: true,
    });
    expect(config.kafka.brokers).toEqual(['localhost:9092']);
  });

  it('should leave the JWT deployment values unset and default the access token to 15 minutes', () => {
    const { jwt } = configuration();

    expect(jwt.issuer).toBeUndefined();
    expect(jwt.audience).toBeUndefined();
    expect(jwt.privateKeyPath).toBeUndefined();
    expect(jwt.accessTtlSeconds).toBe(900);
  });

  it('should default the refresh token lifetime to 7 days', () => {
    expect(configuration().jwt.refreshTtlSeconds).toBe(604800);
  });

  it('should read the refresh token lifetime from the environment', () => {
    process.env.JWT_REFRESH_TTL_SECONDS = '3600';

    expect(configuration().jwt.refreshTtlSeconds).toBe(3600);
  });

  it('should default the absolute session limit to 30 days', () => {
    expect(configuration().jwt.sessionMaxSeconds).toBe(2592000);
  });

  it('should read the absolute session limit from the environment', () => {
    process.env.JWT_SESSION_MAX_SECONDS = '1209600';

    expect(configuration().jwt.sessionMaxSeconds).toBe(1209600);
  });

  it.each(['-1', 'abc', '1.5'])('should reject a session limit of %p', (raw) => {
    process.env.JWT_SESSION_MAX_SECONDS = raw;

    expect(() => configuration()).toThrow('JWT_SESSION_MAX_SECONDS must be a non-negative integer');
  });

  it('should reject a session limit shorter than the refresh token lifetime', () => {
    process.env.JWT_REFRESH_TTL_SECONDS = '3600';
    process.env.JWT_SESSION_MAX_SECONDS = '3599';

    expect(() => configuration()).toThrow(
      'JWT_SESSION_MAX_SECONDS must be >= JWT_REFRESH_TTL_SECONDS',
    );
  });

  it('should accept a session limit equal to the refresh token lifetime', () => {
    process.env.JWT_REFRESH_TTL_SECONDS = '3600';
    process.env.JWT_SESSION_MAX_SECONDS = '3600';

    expect(configuration().jwt.sessionMaxSeconds).toBe(3600);
  });

  it('should default the login rate limit to 10 requests per minute', () => {
    expect(configuration().rateLimit.login).toEqual({ limit: 10, ttlMs: 60000 });
  });

  it('should read the login rate limit from the environment', () => {
    process.env.RATE_LIMIT_LOGIN_LIMIT = '3';
    process.env.RATE_LIMIT_LOGIN_TTL_MS = '2000';

    expect(configuration().rateLimit.login).toEqual({ limit: 3, ttlMs: 2000 });
  });

  it('should default the refresh and logout rate limits to 30 requests per minute', () => {
    const { rateLimit } = configuration();

    expect(rateLimit.refresh).toEqual({ limit: 30, ttlMs: 60000 });
    expect(rateLimit.logout).toEqual({ limit: 30, ttlMs: 60000 });
  });

  it('should read the refresh and logout rate limits from the environment', () => {
    process.env.RATE_LIMIT_REFRESH_LIMIT = '7';
    process.env.RATE_LIMIT_REFRESH_TTL_MS = '1000';
    process.env.RATE_LIMIT_LOGOUT_LIMIT = '4';
    process.env.RATE_LIMIT_LOGOUT_TTL_MS = '2000';

    const { rateLimit } = configuration();

    expect(rateLimit.refresh).toEqual({ limit: 7, ttlMs: 1000 });
    expect(rateLimit.logout).toEqual({ limit: 4, ttlMs: 2000 });
  });

  it('should default argon2 to 64 MiB, 3 iterations and parallelism 4', () => {
    expect(configuration().argon2).toEqual({ memoryCostKib: 65536, timeCost: 3, parallelism: 4 });
  });

  it('should read the argon2 parameters from the environment', () => {
    process.env.ARGON2_MEMORY_COST_KIB = '1024';
    process.env.ARGON2_TIME_COST = '2';
    process.env.ARGON2_PARALLELISM = '1';

    expect(configuration().argon2).toEqual({ memoryCostKib: 1024, timeCost: 2, parallelism: 1 });
  });

  it('should default the register rate limit to 5 requests per minute', () => {
    expect(configuration().rateLimit.register).toEqual({ limit: 5, ttlMs: 60000 });
  });

  it('should read the register rate limit from the environment', () => {
    process.env.RATE_LIMIT_REGISTER_LIMIT = '100';
    process.env.RATE_LIMIT_REGISTER_TTL_MS = '1000';

    expect(configuration().rateLimit.register).toEqual({ limit: 100, ttlMs: 1000 });
  });

  it('should read every value from the environment', () => {
    process.env.PORT = '4001';
    process.env.CORS_ALLOWED_ORIGINS = 'https://shop.example.com, https://admin.example.com';
    process.env.DATABASE_PORT = '6543';
    process.env.DATABASE_MIGRATIONS_RUN = 'false';
    process.env.KAFKA_BROKERS = 'kafka-1:9092,kafka-2:9092';
    process.env.JWT_ISSUER = 'https://identity.example.com';
    process.env.JWT_ACCESS_TTL_SECONDS = '300';

    const config = configuration();

    expect(config.port).toBe(4001);
    expect(config.cors.allowedOrigins).toEqual([
      'https://shop.example.com',
      'https://admin.example.com',
    ]);
    expect(config.database.port).toBe(6543);
    expect(config.database.migrationsRun).toBe(false);
    expect(config.kafka.brokers).toEqual(['kafka-1:9092', 'kafka-2:9092']);
    expect(config.jwt.issuer).toBe('https://identity.example.com');
    expect(config.jwt.accessTtlSeconds).toBe(300);
  });

  it('should treat an empty JWT placeholder as unset', () => {
    process.env.JWT_ISSUER = '';
    process.env.JWT_ACCESS_TTL_SECONDS = '';

    const { jwt } = configuration();

    expect(jwt.issuer).toBeUndefined();
    expect(jwt.accessTtlSeconds).toBe(900);
  });

  it('should drop empty entries from a comma-separated list', () => {
    expect(parseList(' a , ,b,')).toEqual(['a', 'b']);
    expect(parseList('')).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
  });

  it('should fall back to the default when an integer is missing or invalid', () => {
    expect(parseInteger(undefined, 7)).toBe(7);
    expect(parseInteger('  ', 7)).toBe(7);
    expect(parseInteger('abc', 7)).toBe(7);
    expect(parseInteger('42', 7)).toBe(42);
  });

  it('should default to no retired public keys', () => {
    expect(configuration().jwt.retiredPublicKeyPaths).toEqual([]);
  });

  it('should read the retired public key paths in order, trimming and dropping empty entries', () => {
    process.env.JWT_RETIRED_PUBLIC_KEY_PATHS = ' keys/a-public.pem, ,keys/b-public.pem,';

    expect(configuration().jwt.retiredPublicKeyPaths).toEqual([
      'keys/a-public.pem',
      'keys/b-public.pem',
    ]);
  });

  it('should keep the JWKS cache setting raw so it can be validated at startup', () => {
    expect(configuration().jwks.cacheSeconds).toBeUndefined();

    process.env.JWKS_CACHE_SECONDS = 'abc';

    expect(configuration().jwks.cacheSeconds).toBe('abc');
  });

  describe('parseNonNegativeInteger', () => {
    const NAME = 'JWKS_CACHE_SECONDS';

    it('should fall back to the default when unset or empty', () => {
      expect(parseNonNegativeInteger(undefined, 300, NAME)).toBe(300);
      expect(parseNonNegativeInteger('', 300, NAME)).toBe(300);
      expect(parseNonNegativeInteger('  ', 300, NAME)).toBe(300);
    });

    it('should accept a non-negative integer, including 0', () => {
      expect(parseNonNegativeInteger('60', 300, NAME)).toBe(60);
      expect(parseNonNegativeInteger(' 120 ', 300, NAME)).toBe(120);
      expect(parseNonNegativeInteger('0', 300, NAME)).toBe(0);
    });

    it.each(['-1', '1.5', 'abc', '10s', '1e3', '+5', '0x10'])(
      'should reject %p naming the variable',
      (raw) => {
        expect(() => parseNonNegativeInteger(raw, 300, NAME)).toThrow(
          'JWKS_CACHE_SECONDS must be a non-negative integer',
        );
      },
    );
  });
});
