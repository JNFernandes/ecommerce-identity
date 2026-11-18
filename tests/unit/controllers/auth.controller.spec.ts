import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { LoginCommand } from '../../../src/commands/login.command';
import { RefreshCommand } from '../../../src/commands/refresh.command';
import { RegisterCustomerCommand } from '../../../src/commands/register-customer.command';
import { AuthController } from '../../../src/controllers/auth.controller';
import { Email } from '../../../src/domain/email.value-object';
import { DuplicateEmailError } from '../../../src/domain/errors/duplicate-email.error';
import { InvalidCredentialsError } from '../../../src/domain/errors/invalid-credentials.error';
import {
  InvalidRefreshTokenError,
  RefreshFailureReason,
} from '../../../src/domain/errors/invalid-refresh-token.error';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { LoginDto } from '../../../src/dto/login.dto';
import { LoginResponseDto } from '../../../src/dto/login-response.dto';
import { RegisterDto } from '../../../src/dto/register.dto';
import { RegisterResponseDto } from '../../../src/dto/register-response.dto';

describe('AuthController', () => {
  const body: RegisterDto = { email: 'Ana@Example.com ', name: 'Ana', password: 'correct-horse' };
  let execute: jest.Mock<Promise<unknown>, [unknown]>;
  let controller: AuthController;

  beforeEach(() => {
    execute = jest.fn<Promise<unknown>, [unknown]>();
    controller = new AuthController({ execute } as unknown as CommandBus);
  });

  it('should dispatch a RegisterCustomerCommand built from the body', async () => {
    execute.mockResolvedValue(
      User.registerCustomer(Email.create(body.email), UserName.create(body.name), 'hash'),
    );

    await controller.register(body);

    expect(execute).toHaveBeenCalledWith(
      new RegisterCustomerCommand(body.email, body.name, body.password),
    );
  });

  it('should return the mapped response DTO', async () => {
    const user = User.registerCustomer(Email.create(body.email), UserName.create('Ana'), 'hash');
    execute.mockResolvedValue(user);

    await expect(controller.register(body)).resolves.toEqual(RegisterResponseDto.fromUser(user));
  });

  it('should map UserValidationError to 400 with its message', async () => {
    execute.mockRejectedValue(new UserValidationError('email must be a valid email address'));

    const error: unknown = await controller.register(body).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      statusCode: 400,
      message: 'email must be a valid email address',
      error: 'Bad Request',
    });
  });

  it('should map DuplicateEmailError to 409 email already registered', async () => {
    execute.mockRejectedValue(new DuplicateEmailError());

    const error: unknown = await controller.register(body).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      message: 'email already registered',
      error: 'Conflict',
    });
  });

  it('should rethrow any other error unchanged', async () => {
    const failure = new Error('database down');
    execute.mockRejectedValue(failure);

    await expect(controller.register(body)).rejects.toBe(failure);
  });

  describe('login', () => {
    const loginBody: LoginDto = { email: ' Ana@Example.com ', password: ' secret ' };
    const result = {
      accessToken: 'signed.access.token',
      refreshToken: 'opaque-refresh',
      tokenType: 'Bearer' as const,
      expiresIn: 900,
    };

    it('should dispatch a LoginCommand with the raw body and the client IP', async () => {
      execute.mockResolvedValue(result);

      await controller.login(loginBody, '203.0.113.7');

      expect(execute).toHaveBeenCalledWith(
        new LoginCommand(' Ana@Example.com ', ' secret ', '203.0.113.7'),
      );
    });

    it('should return the response DTO', async () => {
      execute.mockResolvedValue(result);

      const response = await controller.login(loginBody, '203.0.113.7');

      expect(response).toBeInstanceOf(LoginResponseDto);
      expect({ ...response }).toEqual(result);
    });

    it('should map UserValidationError to 400', async () => {
      execute.mockRejectedValue(new UserValidationError('email must be a valid email address'));

      await expect(controller.login(loginBody, '203.0.113.7')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should map InvalidCredentialsError to the generic 401 body', async () => {
      execute.mockRejectedValue(new InvalidCredentialsError());

      const error: unknown = await controller
        .login(loginBody, '203.0.113.7')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toEqual({
        statusCode: 401,
        message: 'invalid credentials',
        error: 'Unauthorized',
      });
    });

    it('should rethrow any other error unchanged', async () => {
      const failure = new Error('database down');
      execute.mockRejectedValue(failure);

      await expect(controller.login(loginBody, '203.0.113.7')).rejects.toBe(failure);
    });
  });

  describe('refresh', () => {
    const refreshBody = { refreshToken: 'opaque-refresh' };
    const result = {
      accessToken: 'signed.access.token',
      refreshToken: 'next-opaque-refresh',
      tokenType: 'Bearer' as const,
      expiresIn: 900,
    };

    it('should dispatch a RefreshCommand with the token and the client IP', async () => {
      execute.mockResolvedValue(result);

      await controller.refresh(refreshBody, '203.0.113.7');

      expect(execute).toHaveBeenCalledWith(new RefreshCommand('opaque-refresh', '203.0.113.7'));
    });

    it('should return the login response DTO', async () => {
      execute.mockResolvedValue(result);

      const response = await controller.refresh(refreshBody, '203.0.113.7');

      expect(response).toBeInstanceOf(LoginResponseDto);
      expect({ ...response }).toEqual(result);
    });

    it.each(Object.values(RefreshFailureReason))(
      'should map InvalidRefreshTokenError(%s) to the same generic 401 body',
      async (reason) => {
        execute.mockRejectedValue(new InvalidRefreshTokenError(reason));

        const error: unknown = await controller
          .refresh(refreshBody, '203.0.113.7')
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(UnauthorizedException);
        expect((error as UnauthorizedException).getResponse()).toEqual({
          statusCode: 401,
          message: 'invalid refresh token',
          error: 'Unauthorized',
        });
      },
    );

    it('should rethrow any other error unchanged', async () => {
      const failure = new Error('database down');
      execute.mockRejectedValue(failure);

      await expect(controller.refresh(refreshBody, '203.0.113.7')).rejects.toBe(failure);
    });
  });
});
