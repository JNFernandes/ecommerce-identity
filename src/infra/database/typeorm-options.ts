import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { DatabaseConfig } from '../../config/configuration';
import { OutboundDeadLetterEntity } from './entities/outbound-dead-letter.entity';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { UserEntity } from './entities/user.entity';

/**
 * Glob of the TypeORM migrations, next to this file. It resolves to the `.ts` sources under
 * ts-node and to the compiled `.js` files in `dist` (TypeORM skips `.d.ts` files).
 */
export const MIGRATIONS_GLOB = `${__dirname}/migrations/*{.ts,.js}`;

/** Glob of the TypeORM entities, used by the migration CLI data source. */
export const ENTITIES_GLOB = `${__dirname}/entities/*.entity{.ts,.js}`;

/** Every TypeORM entity of the service. */
export const ENTITIES = [UserEntity, OutboundDeadLetterEntity, RefreshTokenEntity];

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
    entities: ENTITIES,
    migrations: [MIGRATIONS_GLOB],
  };
}

/**
 * The application's TypeORM options: the shared entities plus any registered by feature modules,
 * and pending migrations applied at startup unless `migrationsRun` is false.
 */
export function buildTypeOrmOptions(dbConfig: DatabaseConfig): TypeOrmModuleOptions {
  return {
    ...buildDataSourceOptions(dbConfig),
    autoLoadEntities: true,
    migrationsRun: dbConfig.migrationsRun,
  };
}
