import { Role } from '../../../src/domain/role.enum';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { CurrentUserResponseDto } from '../../../src/dto/current-user-response.dto';
import { CurrentUserReadModel } from '../../../src/services/get-current-user.service';

const CUSTOMER: CurrentUserReadModel = {
  id: '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b',
  customerId: '7a2d3b0f-9e54-4c1a-8b8f-3d6e2f4a5b6c',
  email: 'ana@example.com',
  name: 'Ana',
  roles: [Role.CUSTOMER],
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-11-18T10:00:00.000Z'),
};

describe('CurrentUserResponseDto.from', () => {
  it('should return exactly the seven fields for a customer', () => {
    expect(JSON.parse(JSON.stringify(CurrentUserResponseDto.from(CUSTOMER)))).toEqual({
      id: CUSTOMER.id,
      customerId: CUSTOMER.customerId,
      email: 'ana@example.com',
      name: 'Ana',
      roles: ['CUSTOMER'],
      status: 'ACTIVE',
      createdAt: '2026-11-18T10:00:00.000Z',
    });
  });

  it('should leave the customerId key out for an admin', () => {
    const json = JSON.parse(
      JSON.stringify(
        CurrentUserResponseDto.from({ ...CUSTOMER, customerId: null, roles: [Role.ADMIN] }),
      ),
    ) as Record<string, unknown>;

    expect(Object.keys(json).sort()).toEqual(
      ['createdAt', 'email', 'id', 'name', 'roles', 'status'].sort(),
    );
    expect('customerId' in json).toBe(false);
  });
});
