import { Email } from '../../../src/domain/email.value-object';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../src/domain/errors/invalid-access-token.error';
import { Role } from '../../../src/domain/role.enum';
import { User, UserProps } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { GetCurrentUserQuery } from '../../../src/queries/get-current-user.query';
import { UserRepository } from '../../../src/repositories/user.repository';
import { GetCurrentUserService } from '../../../src/services/get-current-user.service';

const USER_ID = '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b';
const CUSTOMER_ID = '7a2d3b0f-9e54-4c1a-8b8f-3d6e2f4a5b6c';
const CREATED_AT = new Date('2026-11-01T10:00:00.000Z');

function userWith(overrides: Partial<UserProps> = {}): User {
  return User.restore({
    id: USER_ID,
    customerId: CUSTOMER_ID,
    email: Email.create('ana@example.com'),
    name: UserName.create('Ana'),
    passwordHash: '$argon2id$secret-hash',
    roles: [Role.CUSTOMER],
    status: UserStatus.ACTIVE,
    createdAt: CREATED_AT,
    updatedAt: new Date('2026-11-02T10:00:00.000Z'),
    lastLoginAt: new Date('2026-11-03T10:00:00.000Z'),
    ...overrides,
  });
}

describe('GetCurrentUserService', () => {
  let findById: jest.Mock<Promise<User | null>, [string]>;
  let service: GetCurrentUserService;

  beforeEach(() => {
    findById = jest.fn<Promise<User | null>, [string]>();
    service = new GetCurrentUserService({ findById } as unknown as UserRepository);
  });

  async function expectUnavailable(): Promise<void> {
    const result = service.execute(new GetCurrentUserQuery(USER_ID));
    await expect(result).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(result).rejects.toMatchObject({
      reason: AccessTokenFailureReason.USER_UNAVAILABLE,
    });
  }

  it('should return the read model of an active customer without secrets or timestamps', async () => {
    findById.mockResolvedValue(userWith());

    const model = await service.execute(new GetCurrentUserQuery(USER_ID));

    expect(findById).toHaveBeenCalledWith(USER_ID);
    expect(model).toEqual({
      id: USER_ID,
      customerId: CUSTOMER_ID,
      email: 'ana@example.com',
      name: 'Ana',
      roles: [Role.CUSTOMER],
      status: UserStatus.ACTIVE,
      createdAt: CREATED_AT,
    });
  });

  it('should return an admin with a null customerId', async () => {
    findById.mockResolvedValue(userWith({ customerId: null, roles: [Role.ADMIN] }));

    const model = await service.execute(new GetCurrentUserQuery(USER_ID));

    expect(model.customerId).toBeNull();
    expect(model.roles).toEqual([Role.ADMIN]);
  });

  it('should refuse a missing user', async () => {
    findById.mockResolvedValue(null);

    await expectUnavailable();
  });

  it('should refuse a disabled user', async () => {
    findById.mockResolvedValue(userWith({ status: UserStatus.DISABLED }));

    await expectUnavailable();
  });

  it('should propagate a repository error unchanged', async () => {
    const error = new Error('connection refused');
    findById.mockRejectedValue(error);

    await expect(service.execute(new GetCurrentUserQuery(USER_ID))).rejects.toBe(error);
  });
});
