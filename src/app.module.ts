import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration, { DatabaseConfig, RateLimitConfig } from './config/configuration';
import { OutboundDeadLetterEntity } from './infra/database/entities/outbound-dead-letter.entity';
import { UserEntity } from './infra/database/entities/user.entity';
import { buildTypeOrmOptions } from './infra/database/typeorm-options';
import { KafkaModule } from './infra/kafka/kafka.module';
import { AuthController, REGISTER_THROTTLER } from './controllers/auth.controller';
import { HealthController } from './controllers/health.controller';
import { HealthService } from './services/health.service';
import { OutboundDeadLetterRepository } from './repositories/outbound-dead-letter.repository';
import { UserRepository } from './repositories/user.repository';
import { Argon2PasswordHasher } from './infra/security/argon2-password-hasher';
import { PasswordHasher } from './services/ports/password-hasher';
import { UserEventPublisher } from './services/ports/user-event-publisher';
import { UserEventsProducer } from './infra/kafka/user-events.producer';
import { RegisterCustomerService } from './services/register-customer.service';

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
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { register } = configService.getOrThrow<RateLimitConfig>('rateLimit');
        return [{ name: REGISTER_THROTTLER, limit: register.limit, ttl: register.ttlMs }];
      },
    }),
    KafkaModule,
    CqrsModule,
  ],
  controllers: [HealthController, AuthController],
  providers: [
    HealthService,
    UserRepository,
    OutboundDeadLetterRepository,
    { provide: PasswordHasher, useClass: Argon2PasswordHasher },
    { provide: UserEventPublisher, useClass: UserEventsProducer },
    RegisterCustomerService,
  ],
})
export class AppModule {}
