import configuration, { parseInteger, parseList } from '../../../src/config/configuration';

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
});
