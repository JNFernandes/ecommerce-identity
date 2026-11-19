import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { UsersController } from '../../../src/controllers/users.controller';
import { ChangeUserStatusCommand } from '../../../src/commands/change-user-status.command';
import { CreateUserCommand } from '../../../src/commands/create-user.command';
import { AuthenticatedPrincipal } from '../../../src/domain/authenticated-principal';
import { CannotDisableSelfError } from '../../../src/domain/errors/cannot-disable-self.error';
import { DuplicateEmailError } from '../../../src/domain/errors/duplicate-email.error';
import { LastActiveAdminError } from '../../../src/domain/errors/last-active-admin.error';
import { UserNotFoundError } from '../../../src/domain/errors/user-not-found.error';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { Role } from '../../../src/domain/role.enum';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { ChangeUserStatusDto } from '../../../src/dto/change-user-status.dto';
import { CreateUserDto } from '../../../src/dto/create-user.dto';
import { CurrentUserResponseDto } from '../../../src/dto/current-user-response.dto';
import { ListUsersQueryDto } from '../../../src/dto/list-users-query.dto';
import { UserPageResponseDto } from '../../../src/dto/user-page-response.dto';
import { UserSummaryResponseDto } from '../../../src/dto/user-summary-response.dto';
import { GetCurrentUserQuery } from '../../../src/queries/get-current-user.query';
import { GetUserQuery } from '../../../src/queries/get-user.query';
import { ListUsersQuery } from '../../../src/queries/list-users.query';
import {
  UserPageReadModel,
  UserSummaryReadModel,
} from '../../../src/queries/user-summary.read-model';
import { CurrentUserReadModel } from '../../../src/services/get-current-user.service';

const USER_ID = '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b';

describe('UsersController', () => {
  it('should dispatch GetCurrentUserQuery with the principal user id and return the DTO', async () => {
    const model: CurrentUserReadModel = {
      id: USER_ID,
      customerId: '7a2d3b0f-9e54-4c1a-8b8f-3d6e2f4a5b6c',
      email: 'ana@example.com',
      name: 'Ana',
      roles: [Role.CUSTOMER],
      status: UserStatus.ACTIVE,
      createdAt: new Date('2026-11-18T10:00:00.000Z'),
    };
    const execute = jest.fn().mockResolvedValue(model);
    const controller = new UsersController({ execute } as unknown as QueryBus, {} as CommandBus);
    const principal = AuthenticatedPrincipal.fromClaims({
      sub: USER_ID,
      roles: ['CUSTOMER'],
      customerId: model.customerId,
    });

    const response = await controller.me(principal);

    expect(execute).toHaveBeenCalledWith(new GetCurrentUserQuery(USER_ID));
    expect(response).toBeInstanceOf(CurrentUserResponseDto);
    expect(response).toEqual(CurrentUserResponseDto.from(model));
  });

  it('should dispatch ListUsersQuery with the validated parameters and return the page DTO', async () => {
    const page: UserPageReadModel = {
      items: [
        {
          id: USER_ID,
          customerId: null,
          email: 'admin@example.com',
          name: 'Administrator',
          roles: [Role.ADMIN],
          status: UserStatus.ACTIVE,
          createdAt: new Date('2026-11-18T10:00:00.000Z'),
          lastLoginAt: null,
        },
      ],
      total: 9,
      limit: 5,
      offset: 5,
    };
    const execute = jest.fn().mockResolvedValue(page);
    const controller = new UsersController({ execute } as unknown as QueryBus, {} as CommandBus);
    const query = Object.assign(new ListUsersQueryDto(), {
      limit: 5,
      offset: 5,
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      email: 'adm',
    });

    const response = await controller.list(query);

    expect(execute).toHaveBeenCalledWith(
      new ListUsersQuery(5, 5, Role.ADMIN, UserStatus.ACTIVE, 'adm'),
    );
    expect(response).toBeInstanceOf(UserPageResponseDto);
    expect(response).toEqual(UserPageResponseDto.from(page));
  });

  it('should pass absent filters as undefined', async () => {
    const execute = jest.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    const controller = new UsersController({ execute } as unknown as QueryBus, {} as CommandBus);

    await controller.list(new ListUsersQueryDto());

    expect(execute).toHaveBeenCalledWith(new ListUsersQuery(20, 0));
  });

  describe('findOne', () => {
    const user: UserSummaryReadModel = {
      id: USER_ID,
      customerId: '7a2d3b0f-9e54-4c1a-8b8f-3d6e2f4a5b6c',
      email: 'ana@example.com',
      name: 'Ana',
      roles: [Role.CUSTOMER],
      status: UserStatus.ACTIVE,
      createdAt: new Date('2026-11-18T10:00:00.000Z'),
      lastLoginAt: new Date('2026-11-18T11:00:00.000Z'),
    };

    it('should dispatch GetUserQuery with the id and return the DTO', async () => {
      const execute = jest.fn().mockResolvedValue(user);
      const controller = new UsersController({ execute } as unknown as QueryBus, {} as CommandBus);

      const response = await controller.findOne(USER_ID);

      expect(execute).toHaveBeenCalledWith(new GetUserQuery(USER_ID));
      expect(response).toBeInstanceOf(UserSummaryResponseDto);
      expect(response).toEqual(UserSummaryResponseDto.from(user));
    });

    it('should map UserNotFoundError to a 404 "user not found"', async () => {
      const execute = jest.fn().mockRejectedValue(new UserNotFoundError());
      const controller = new UsersController({ execute } as unknown as QueryBus, {} as CommandBus);

      const failure = controller.findOne(USER_ID);

      await expect(failure).rejects.toBeInstanceOf(NotFoundException);
      await expect(failure).rejects.toMatchObject({
        response: { statusCode: 404, message: 'user not found', error: 'Not Found' },
      });
    });

    it('should let any other error propagate unchanged', async () => {
      const boom = new Error('connection refused');
      const execute = jest.fn().mockRejectedValue(boom);
      const controller = new UsersController({ execute } as unknown as QueryBus, {} as CommandBus);

      await expect(controller.findOne(USER_ID)).rejects.toBe(boom);
    });
  });

  describe('changeStatus', () => {
    const ADMIN_ID = '0b9e8c7d-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
    const admin = AuthenticatedPrincipal.fromClaims({ sub: ADMIN_ID, roles: ['ADMIN'] });
    const updated: UserSummaryReadModel = {
      id: USER_ID,
      customerId: '7a2d3b0f-9e54-4c1a-8b8f-3d6e2f4a5b6c',
      email: 'ana@example.com',
      name: 'Ana',
      roles: [Role.CUSTOMER],
      status: UserStatus.DISABLED,
      createdAt: new Date('2026-11-18T10:00:00.000Z'),
      lastLoginAt: null,
    };

    function controllerWith(execute: jest.Mock): UsersController {
      return new UsersController({} as QueryBus, { execute } as unknown as CommandBus);
    }

    const dto = (status: UserStatus): ChangeUserStatusDto =>
      Object.assign(new ChangeUserStatusDto(), { status });

    it('should dispatch ChangeUserStatusCommand with the principal id and return the DTO', async () => {
      const execute = jest.fn().mockResolvedValue(updated);

      const response = await controllerWith(execute).changeStatus(
        USER_ID,
        dto(UserStatus.DISABLED),
        admin,
      );

      expect(execute).toHaveBeenCalledWith(
        new ChangeUserStatusCommand(USER_ID, UserStatus.DISABLED, ADMIN_ID),
      );
      expect(response).toBeInstanceOf(UserSummaryResponseDto);
      expect(response).toEqual(UserSummaryResponseDto.from(updated));
    });

    it('should map UserNotFoundError to a 404 with the fixed message', async () => {
      const execute = jest.fn().mockRejectedValue(new UserNotFoundError());

      const error: unknown = await controllerWith(execute)
        .changeStatus(USER_ID, dto(UserStatus.ACTIVE), admin)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toEqual({
        statusCode: 404,
        message: 'user not found',
        error: 'Not Found',
      });
    });

    it.each([
      [new CannotDisableSelfError(), 'an admin cannot disable their own account'],
      [new LastActiveAdminError(), 'the last active admin cannot be disabled'],
    ])('should map %p to a 409 with the contract message', async (failure, message) => {
      const execute = jest.fn().mockRejectedValue(failure);

      const error: unknown = await controllerWith(execute)
        .changeStatus(USER_ID, dto(UserStatus.DISABLED), admin)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        statusCode: 409,
        message,
        error: 'Conflict',
      });
    });

    it('should propagate any other error unchanged', async () => {
      const failure = new Error('connection refused');
      const execute = jest.fn().mockRejectedValue(failure);

      await expect(
        controllerWith(execute).changeStatus(USER_ID, dto(UserStatus.DISABLED), admin),
      ).rejects.toBe(failure);
    });
  });
  describe('create', () => {
    const admin = AuthenticatedPrincipal.fromClaims({ sub: USER_ID, roles: ['ADMIN'] });
    const created: UserSummaryReadModel = {
      id: '7a2d3b0f-9e54-4c1a-8b8f-3d6e2f4a5b6c',
      customerId: null,
      email: 'bea@example.com',
      name: 'Bea',
      roles: [Role.ADMIN],
      status: UserStatus.ACTIVE,
      createdAt: new Date('2026-11-19T10:00:00.000Z'),
      lastLoginAt: null,
    };

    function body(): CreateUserDto {
      return Object.assign(new CreateUserDto(), {
        email: 'bea@example.com',
        name: 'Bea',
        password: 'correct-horse-battery',
        roles: [Role.ADMIN],
      });
    }

    function controllerWith(execute: jest.Mock): UsersController {
      return new UsersController({} as QueryBus, { execute } as unknown as CommandBus);
    }

    it('should dispatch CreateUserCommand built from the principal and the body', async () => {
      const execute = jest.fn().mockResolvedValue(created);

      const response = await controllerWith(execute).create(body(), admin);

      expect(execute).toHaveBeenCalledWith(
        new CreateUserCommand(USER_ID, 'bea@example.com', 'Bea', 'correct-horse-battery', [
          Role.ADMIN,
        ]),
      );
      expect(response).toBeInstanceOf(UserSummaryResponseDto);
      expect(response).toEqual(UserSummaryResponseDto.from(created));
    });

    it('should map a rule violation to 400 with its message', async () => {
      const execute = jest.fn().mockRejectedValue(new UserValidationError('name is required'));

      await expect(controllerWith(execute).create(body(), admin)).rejects.toEqual(
        new BadRequestException('name is required'),
      );
    });

    it('should map a duplicate email to 409', async () => {
      const execute = jest.fn().mockRejectedValue(new DuplicateEmailError());

      await expect(controllerWith(execute).create(body(), admin)).rejects.toEqual(
        new ConflictException('email already registered'),
      );
    });

    it('should rethrow any other error unchanged', async () => {
      const failure = new Error('boom');
      const execute = jest.fn().mockRejectedValue(failure);

      await expect(controllerWith(execute).create(body(), admin)).rejects.toBe(failure);
    });
  });
});
