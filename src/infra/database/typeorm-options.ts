import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { DatabaseConfig } from '../../config/configuration';

/**
 * Glob of the TypeORM migrations, next to this file. It resolves to the `.ts` sources under
 * ts-node and to the compiled `.js` files in `dist` (TypeORM skips `.d.ts` files).
 */
export const MIGRATIONS_GLOB = `${__dirname}/migrations/*{.ts,.js}`;

/** Glob of the TypeORM entities, used by the migration CLI data source. */
export const ENTITIES_GLOB = `${__dirname}/entities/*.entity{.ts,.js}`;

/**
 * Connection options shared by the application and the migration CLI. The schema is owned by the
 * migrations: `synchronize` is always off.
 */
export function buildDataSourceOptions(dbConfig: DatabaseConfig): PostgresConnectionOptions {
  return {
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.database,
    synchronize: false,
    migrations: [MIGRATIONS_GLOB],
  };
}

/**
 * The application's TypeORM options: entities are registered by their feature modules, and
 * pending migrations are applied at startup unless `migrationsRun` is false.
 */
export function buildTypeOrmOptions(dbConfig: DatabaseConfig): TypeOrmModuleOptions {
  return {
    ...buildDataSourceOptions(dbConfig),
    autoLoadEntities: true,
    migrationsRun: dbConfig.migrationsRun,
  };
}
