import { QueryBus } from '@nestjs/cqrs';
import { UsersController } from '../../../src/controllers/users.controller';
import { AuthenticatedPrincipal } from '../../../src/domain/authenticated-principal';
import { Role } from '../../../src/domain/role.enum';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { CurrentUserResponseDto } from '../../../src/dto/current-user-response.dto';
import { GetCurrentUserQuery } from '../../../src/queries/get-current-user.query';
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
    const controller = new UsersController({ execute } as unknown as QueryBus);
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
});
