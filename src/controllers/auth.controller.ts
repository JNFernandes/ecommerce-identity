import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { LoginCommand } from '../commands/login.command';
import { LogoutCommand } from '../commands/logout.command';
import { RefreshCommand } from '../commands/refresh.command';
import { RegisterCustomerCommand } from '../commands/register-customer.command';
import { DuplicateEmailError } from '../domain/errors/duplicate-email.error';
import { InvalidCredentialsError } from '../domain/errors/invalid-credentials.error';
import { InvalidRefreshTokenError } from '../domain/errors/invalid-refresh-token.error';
import { UserValidationError } from '../domain/errors/user-validation.error';
import { User } from '../domain/user.aggregate';
import { LoginDto } from '../dto/login.dto';
import { LoginResponseDto } from '../dto/login-response.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { RegisterDto } from '../dto/register.dto';
import { RegisterResponseDto } from '../dto/register-response.dto';
import { LoginResult } from '../services/login.service';
import {
  LOGIN_EMAIL_THROTTLER,
  LOGIN_IP_THROTTLER,
  LOGOUT_THROTTLER,
  REFRESH_THROTTLER,
} from './login-throttle.tracker';

/** Name of the throttler that limits `POST /auth/register` per client IP. */
export const REGISTER_THROTTLER = 'register';

/** Every named throttler registered by the app. */
const ALL_THROTTLERS = [
  REGISTER_THROTTLER,
  LOGIN_IP_THROTTLER,
  LOGIN_EMAIL_THROTTLER,
  REFRESH_THROTTLER,
  LOGOUT_THROTTLER,
] as const;

/**
 * Skips every named throttler except the route's own, so each route only counts against its own
 * buckets.
 *
 * @param own The throttlers that apply to the route.
 */
function onlyThrottlers(...own: string[]): MethodDecorator & ClassDecorator {
  return SkipThrottle(
    Object.fromEntries(
      ALL_THROTTLERS.filter((name) => !own.includes(name)).map((name) => [name, true]),
    ),
  );
}

/** Public authentication endpoints. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  /** @param commandBus Dispatches commands to their handlers. */
  constructor(private readonly commandBus: CommandBus) {}

  /**
   * Registers a customer account (public). Returns the new account without any secret.
   *
   * @param body The validated registration body.
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ThrottlerGuard)
  @onlyThrottlers(REGISTER_THROTTLER)
  @ApiCreatedResponse({ type: RegisterResponseDto, description: 'Customer account created' })
  @ApiBadRequestResponse({
    description: 'Malformed body, unknown property, or invalid email, name or password',
  })
  @ApiConflictResponse({ description: 'email already registered' })
  @ApiTooManyRequestsResponse({ description: 'Too many registrations from this client IP' })
  async register(@Body() body: RegisterDto): Promise<RegisterResponseDto> {
    try {
      const user = await this.commandBus.execute<RegisterCustomerCommand, User>(
        new RegisterCustomerCommand(body.email, body.name, body.password),
      );
      return RegisterResponseDto.fromUser(user);
    } catch (error) {
      throw AuthController.toHttpError(error);
    }
  }

  /**
   * Logs in with email and password (public). Returns an access token and a refresh token.
   * Rate limited per client IP and per normalized email; every request counts, including 400s.
   *
   * @param body The validated login body.
   * @param clientIp The client IP (`req.ip`), passed on for logging only.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @onlyThrottlers(LOGIN_IP_THROTTLER, LOGIN_EMAIL_THROTTLER)
  @ApiOkResponse({ type: LoginResponseDto, description: 'Logged in; tokens issued' })
  @ApiBadRequestResponse({
    description: 'Malformed body, unknown property, missing or non-string field, or invalid email',
  })
  @ApiUnauthorizedResponse({
    description: 'invalid credentials (unknown email, wrong password or inactive user, alike)',
  })
  @ApiTooManyRequestsResponse({
    description: 'Too many login attempts from this client IP or for this email',
  })
  async login(@Body() body: LoginDto, @Ip() clientIp: string): Promise<LoginResponseDto> {
    try {
      const result = await this.commandBus.execute<LoginCommand, LoginResult>(
        new LoginCommand(body.email, body.password, clientIp),
      );
      return LoginResponseDto.fromResult(result);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        throw new UnauthorizedException('invalid credentials');
      }
      throw AuthController.toHttpError(error);
    }
  }

  /**
   * Exchanges a refresh token for a new access token and refresh token (public; the refresh token
   * is the credential). The presented token is single use. Every token or account failure returns
   * the same 401 body.
   *
   * @param body The validated body holding the refresh token.
   * @param clientIp The client IP (`req.ip`), passed on for logging only.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @onlyThrottlers(REFRESH_THROTTLER)
  @ApiOkResponse({ type: LoginResponseDto, description: 'Session refreshed; new tokens issued' })
  @ApiBadRequestResponse({
    description: 'Malformed body, unknown property, or missing, empty or non-string refreshToken',
  })
  @ApiUnauthorizedResponse({
    description:
      'invalid refresh token (unknown, expired, reused or revoked token, inactive user or ' +
      'session limit reached, alike); reuse revokes the whole session',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many refresh requests from this client IP' })
  async refresh(@Body() body: RefreshTokenDto, @Ip() clientIp: string): Promise<LoginResponseDto> {
    try {
      const result = await this.commandBus.execute<RefreshCommand, LoginResult>(
        new RefreshCommand(body.refreshToken, clientIp),
      );
      return LoginResponseDto.fromResult(result);
    } catch (error) {
      if (error instanceof InvalidRefreshTokenError) {
        throw new UnauthorizedException('invalid refresh token');
      }
      throw error;
    }
  }

  /**
   * Ends the session a refresh token belongs to (public; the refresh token is the credential).
   * Always answers 204 for a well-formed body, whatever the token's state, so the response reveals
   * nothing about it. Access tokens already issued stay valid until they expire.
   *
   * @param body The validated body holding the refresh token.
   * @param clientIp The client IP (`req.ip`), passed on for logging only.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @onlyThrottlers(LOGOUT_THROTTLER)
  @ApiNoContentResponse({
    description: 'Session ended (or the token was unknown, expired or already revoked); no body',
  })
  @ApiBadRequestResponse({
    description: 'Malformed body, unknown property, or missing, empty or non-string refreshToken',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many logout requests from this client IP' })
  async logout(@Body() body: RefreshTokenDto, @Ip() clientIp: string): Promise<void> {
    await this.commandBus.execute<LogoutCommand, void>(
      new LogoutCommand(body.refreshToken, clientIp),
    );
  }

  /** Maps domain errors to HTTP errors; anything else is returned unchanged. */
  private static toHttpError(error: unknown): unknown {
    if (error instanceof UserValidationError) {
      return new BadRequestException(error.message);
    }
    if (error instanceof DuplicateEmailError) {
      return new ConflictException('email already registered');
    }
    return error;
  }
}
