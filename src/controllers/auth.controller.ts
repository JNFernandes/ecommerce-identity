import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { RegisterCustomerCommand } from '../commands/register-customer.command';
import { DuplicateEmailError } from '../domain/errors/duplicate-email.error';
import { UserValidationError } from '../domain/errors/user-validation.error';
import { User } from '../domain/user.aggregate';
import { RegisterDto } from '../dto/register.dto';
import { RegisterResponseDto } from '../dto/register-response.dto';

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

  /** Maps registration domain errors to HTTP errors; anything else is returned unchanged. */
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
