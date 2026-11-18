import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration, {
  DatabaseConfig,
  JwksConfig,
  JwtConfig,
  parseNonNegativeInteger,
  RateLimitConfig,
} from './config/configuration';
import { OutboundDeadLetterEntity } from './infra/database/entities/outbound-dead-letter.entity';
import { RefreshTokenEntity } from './infra/database/entities/refresh-token.entity';
import { UserEntity } from './infra/database/entities/user.entity';
import { buildTypeOrmOptions } from './infra/database/typeorm-options';
import { KafkaModule } from './infra/kafka/kafka.module';
import { AuthController, REGISTER_THROTTLER } from './controllers/auth.controller';
import { HealthController } from './controllers/health.controller';
import { JwksController } from './controllers/jwks.controller';
import {
  LOGIN_EMAIL_THROTTLER,
  LOGIN_IP_THROTTLER,
  loginThrottleTracker,
} from './controllers/login-throttle.tracker';
import { HealthService } from './services/health.service';
import { OutboundDeadLetterRepository } from './repositories/outbound-dead-letter.repository';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { UserRepository } from './repositories/user.repository';
import { Argon2PasswordHasher } from './infra/security/argon2-password-hasher';
import { CryptoRefreshTokenGenerator } from './infra/security/crypto-refresh-token-generator';
import { JoseTokenIssuer } from './infra/security/jose-token-issuer';
import { KeyRing, loadKeyRing } from './infra/security/key-ring';
import { SigningKey } from './infra/security/signing-key';
import { SystemClock } from './infra/time/system-clock';
import { Clock } from './services/ports/clock';
import { PasswordHasher } from './services/ports/password-hasher';
import { RefreshTokenGenerator } from './services/ports/refresh-token-generator';
import { TokenIssuer } from './services/ports/token-issuer';
import { UserEventPublisher } from './services/ports/user-event-publisher';
import { UserEventsProducer } from './infra/kafka/user-events.producer';
import { DEFAULT_JWKS_CACHE_SECONDS, JwksService } from './services/jwks.service';
import { LoginService } from './services/login.service';
import { PublicKeySet } from './services/ports/public-key-set';
import { RefreshService } from './services/refresh.service';
import { RegisterCustomerService } from './services/register-customer.service';

/**
 * Builds the access token issuer, failing fast when `JWT_ISSUER` or `JWT_AUDIENCE` is unset so the
 * app never starts unable to sign valid tokens.
 */
function createTokenIssuer(signingKey: SigningKey, configService: ConfigService): TokenIssuer {
  const { issuer, audience, accessTtlSeconds } = configService.getOrThrow<JwtConfig>('jwt');
  if (issuer === undefined) {
    throw new Error('JWT_ISSUER is not set');
  }
  if (audience === undefined) {
    throw new Error('JWT_AUDIENCE is not set');
  }
  return new JoseTokenIssuer(signingKey, { issuer, audience, accessTtlSeconds });
}

/**
 * Builds the JWKS service, failing fast when `JWKS_CACHE_SECONDS` is not a non-negative integer.
 */
function createJwksService(publicKeySet: PublicKeySet, configService: ConfigService): JwksService {
  const { cacheSeconds } = configService.getOrThrow<JwksConfig>('jwks');
  return new JwksService(
    publicKeySet,
    parseNonNegativeInteger(cacheSeconds, DEFAULT_JWKS_CACHE_SECONDS, 'JWKS_CACHE_SECONDS'),
  );
}

/** Root module of the identity service. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildTypeOrmOptions(configService.getOrThrow<DatabaseConfig>('database')),
    }),
    TypeOrmModule.forFeature([UserEntity, OutboundDeadLetterEntity, RefreshTokenEntity]),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { register, login } = configService.getOrThrow<RateLimitConfig>('rateLimit');
        return [
          { name: REGISTER_THROTTLER, limit: register.limit, ttl: register.ttlMs },
          {
            name: LOGIN_IP_THROTTLER,
            limit: login.limit,
            ttl: login.ttlMs,
            getTracker: loginThrottleTracker('ip'),
          },
          {
            name: LOGIN_EMAIL_THROTTLER,
            limit: login.limit,
            ttl: login.ttlMs,
            getTracker: loginThrottleTracker('email'),
          },
        ];
      },
    }),
    KafkaModule,
    CqrsModule,
  ],
  controllers: [HealthController, AuthController, JwksController],
  providers: [
    HealthService,
    UserRepository,
    OutboundDeadLetterRepository,
    RefreshTokenRepository,
    { provide: PasswordHasher, useClass: Argon2PasswordHasher },
    {
      provide: KeyRing,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Promise<KeyRing> => {
        const jwt = configService.getOrThrow<JwtConfig>('jwt');
        return loadKeyRing({
          activePrivateKeyPath: jwt.privateKeyPath,
          retiredPublicKeyPaths: jwt.retiredPublicKeyPaths,
        });
      },
    },
    {
      provide: SigningKey,
      inject: [KeyRing],
      useFactory: (ring: KeyRing): SigningKey => ring.activeKey,
    },
    { provide: PublicKeySet, useExisting: KeyRing },
    { provide: TokenIssuer, inject: [SigningKey, ConfigService], useFactory: createTokenIssuer },
    { provide: JwksService, inject: [PublicKeySet, ConfigService], useFactory: createJwksService },
    { provide: RefreshTokenGenerator, useClass: CryptoRefreshTokenGenerator },
    { provide: Clock, useClass: SystemClock },
    { provide: UserEventPublisher, useClass: UserEventsProducer },
    RegisterCustomerService,
    LoginService,
    RefreshService,
  ],
})
export class AppModule {}
