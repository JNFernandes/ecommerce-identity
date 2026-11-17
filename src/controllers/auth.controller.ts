import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { RegisterCustomerCommand } from '../commands/register-customer.command';
import { User } from '../domain/user.aggregate';
import { RegisterDto } from '../dto/register.dto';
import { RegisterResponseDto } from '../dto/register-response.dto';

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
  @ApiCreatedResponse({ type: RegisterResponseDto, description: 'Customer account created' })
  async register(@Body() body: RegisterDto): Promise<RegisterResponseDto> {
    const user = await this.commandBus.execute<RegisterCustomerCommand, User>(
      new RegisterCustomerCommand(body.email, body.name, body.password),
    );
    return RegisterResponseDto.fromUser(user);
  }
}
