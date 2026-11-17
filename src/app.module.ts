import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration, { DatabaseConfig } from './config/configuration';
import { OutboundDeadLetterEntity } from './infra/database/entities/outbound-dead-letter.entity';
import { UserEntity } from './infra/database/entities/user.entity';
import { buildTypeOrmOptions } from './infra/database/typeorm-options';
import { KafkaModule } from './infra/kafka/kafka.module';
import { HealthController } from './controllers/health.controller';
import { HealthService } from './services/health.service';
import { UserRepository } from './repositories/user.repository';

/** Root module of the identity service. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildTypeOrmOptions(configService.getOrThrow<DatabaseConfig>('database')),
    }),
    TypeOrmModule.forFeature([UserEntity, OutboundDeadLetterEntity]),
    KafkaModule,
    CqrsModule,
  ],
  controllers: [HealthController],
  providers: [HealthService, UserRepository],
})
export class AppModule {}
