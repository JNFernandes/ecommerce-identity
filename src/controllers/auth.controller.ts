import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { LoginCommand } from '../commands/login.command';
import { RegisterCustomerCommand } from '../commands/register-customer.command';
import { DuplicateEmailError } from '../domain/errors/duplicate-email.error';
import { UserValidationError } from '../domain/errors/user-validation.error';
import { User } from '../domain/user.aggregate';
import { LoginDto } from '../dto/login.dto';
import { LoginResponseDto } from '../dto/login-response.dto';
import { RegisterDto } from '../dto/register.dto';
import { RegisterResponseDto } from '../dto/register-response.dto';
import { LoginResult } from '../services/login.service';

/** Name of the throttler that limits `POST /auth/register` per client IP. */
export const REGISTER_THROTTLER = 'register';

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
   *
   * @param body The validated login body.
   * @param clientIp The client IP (`req.ip`), passed on for logging only.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: LoginResponseDto, description: 'Logged in; tokens issued' })
  @ApiBadRequestResponse({
    description: 'Malformed body, unknown property, missing or non-string field, or invalid email',
  })
  async login(@Body() body: LoginDto, @Ip() clientIp: string): Promise<LoginResponseDto> {
    try {
      const result = await this.commandBus.execute<LoginCommand, LoginResult>(
        new LoginCommand(body.email, body.password, clientIp),
      );
      return LoginResponseDto.fromResult(result);
    } catch (error) {
      throw AuthController.toHttpError(error);
    }
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
