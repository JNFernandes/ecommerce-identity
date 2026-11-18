import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, DiscoveryModule } from '@nestjs/core';
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
import { AccessTokenExceptionFilter } from './controllers/auth/access-token-exception.filter';
import { JwtAuthGuard } from './controllers/auth/jwt-auth.guard';
import { RolesGuard } from './controllers/auth/roles.guard';
import { RoutePolicyCheck } from './controllers/auth/route-policy.check';
import { AuthController, REGISTER_THROTTLER } from './controllers/auth.controller';
import { HealthController } from './controllers/health.controller';
import { JwksController } from './controllers/jwks.controller';
import { UsersController } from './controllers/users.controller';
import {
  LOGIN_EMAIL_THROTTLER,
  LOGIN_IP_THROTTLER,
  loginThrottleTracker,
  LOGOUT_THROTTLER,
  REFRESH_THROTTLER,
} from './controllers/login-throttle.tracker';
import { HealthService } from './services/health.service';
import { OutboundDeadLetterRepository } from './repositories/outbound-dead-letter.repository';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { UserRepository } from './repositories/user.repository';
import { Argon2PasswordHasher } from './infra/security/argon2-password-hasher';
import { CryptoRefreshTokenGenerator } from './infra/security/crypto-refresh-token-generator';
import { JoseAccessTokenVerifier } from './infra/auth/jose-access-token-verifier';
import { JoseTokenIssuer } from './infra/security/jose-token-issuer';
import { KeyRing, loadKeyRing } from './infra/security/key-ring';
import { SigningKey } from './infra/security/signing-key';
import { SystemClock } from './infra/time/system-clock';
import { AccessTokenVerifier } from './services/ports/access-token-verifier';
import { Clock } from './services/ports/clock';
import { PasswordHasher } from './services/ports/password-hasher';
import { RefreshTokenGenerator } from './services/ports/refresh-token-generator';
import { TokenIssuer } from './services/ports/token-issuer';
import { UserEventPublisher } from './services/ports/user-event-publisher';
import { UserEventsProducer } from './infra/kafka/user-events.producer';
import { DEFAULT_JWKS_CACHE_SECONDS, JwksService } from './services/jwks.service';
import { AdminSeedService } from './services/admin-seed.service';
import { ChangeUserStatusService } from './services/change-user-status.service';
import { GetUserService } from './services/get-user.service';
import { ListUsersService } from './services/list-users.service';
import { GetCurrentUserService } from './services/get-current-user.service';
import { LoginService } from './services/login.service';
import { LogoutService } from './services/logout.service';
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
 * Builds the access token verifier over every published key (active and retired), failing fast
 * when `JWT_ISSUER` or `JWT_AUDIENCE` is unset.
 */
function createAccessTokenVerifier(
  ring: KeyRing,
  configService: ConfigService,
  clock: Clock,
): Promise<AccessTokenVerifier> {
  const { issuer, audience, clockToleranceSeconds } = configService.getOrThrow<JwtConfig>('jwt');
  if (issuer === undefined) {
    throw new Error('JWT_ISSUER is not set');
  }
  if (audience === undefined) {
    throw new Error('JWT_AUDIENCE is not set');
  }
  return JoseAccessTokenVerifier.create(
    ring.keys,
    { issuer, audience, clockToleranceSeconds },
    clock,
  );
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
        const { register, login, refresh, logout } =
          configService.getOrThrow<RateLimitConfig>('rateLimit');
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
          {
            name: REFRESH_THROTTLER,
            limit: refresh.limit,
            ttl: refresh.ttlMs,
            getTracker: loginThrottleTracker('ip'),
          },
          {
            name: LOGOUT_THROTTLER,
            limit: logout.limit,
            ttl: logout.ttlMs,
            getTracker: loginThrottleTracker('ip'),
          },
        ];
      },
    }),
    KafkaModule,
    CqrsModule,
    DiscoveryModule,
  ],
  controllers: [HealthController, AuthController, JwksController, UsersController],
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
    {
      provide: AccessTokenVerifier,
      inject: [KeyRing, ConfigService, Clock],
      useFactory: createAccessTokenVerifier,
    },
    // Global guards run in registration order: authentication (401), then roles (403).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AccessTokenExceptionFilter },
    RoutePolicyCheck,
    { provide: UserEventPublisher, useClass: UserEventsProducer },
    RegisterCustomerService,
    LoginService,
    RefreshService,
    LogoutService,
    GetCurrentUserService,
    AdminSeedService,
    ListUsersService,
    GetUserService,
    ChangeUserStatusService,
  ],
})
export class AppModule {}
