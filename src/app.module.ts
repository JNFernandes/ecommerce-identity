import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration, { DatabaseConfig } from './config/configuration';
import { buildTypeOrmOptions } from './infra/database/typeorm-options';

/** Root module of the identity service. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildTypeOrmOptions(configService.getOrThrow<DatabaseConfig>('database')),
    }),
  ],
})
export class AppModule {}
