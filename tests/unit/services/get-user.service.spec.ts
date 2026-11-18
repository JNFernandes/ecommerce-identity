import { UserNotFoundError } from '../../../src/domain/errors/user-not-found.error';
import { Role } from '../../../src/domain/role.enum';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { GetUserQuery } from '../../../src/queries/get-user.query';
import { UserSummaryReadModel } from '../../../src/queries/user-summary.read-model';
import { UserRepository } from '../../../src/repositories/user.repository';
import { GetUserService } from '../../../src/services/get-user.service';

const USER_ID = '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b';

describe('GetUserService', () => {
  let findSummaryById: jest.Mock<Promise<UserSummaryReadModel | null>, [string]>;
  let service: GetUserService;

  const user: UserSummaryReadModel = {
    id: USER_ID,
    customerId: '7a2d3b0f-9e54-4c1a-8b8f-3d6e2f4a5b6c',
    email: 'ana@example.com',
    name: 'Ana',
    roles: [Role.CUSTOMER],
    status: UserStatus.ACTIVE,
    createdAt: new Date('2026-11-18T10:00:00.000Z'),
    lastLoginAt: null,
  };

  beforeEach(() => {
    findSummaryById = jest
      .fn<Promise<UserSummaryReadModel | null>, [string]>()
      .mockResolvedValue(user);
    service = new GetUserService({ findSummaryById } as unknown as UserRepository);
  });

  it('should return the stored user', async () => {
    await expect(service.execute(new GetUserQuery(USER_ID))).resolves.toBe(user);
    expect(findSummaryById).toHaveBeenCalledWith(USER_ID);
  });

  it('should throw UserNotFoundError when no user has the id', async () => {
    findSummaryById.mockResolvedValue(null);

    await expect(service.execute(new GetUserQuery(USER_ID))).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });

  it('should propagate a repository error unchanged', async () => {
    findSummaryById.mockRejectedValue(new Error('connection refused'));

    await expect(service.execute(new GetUserQuery(USER_ID))).rejects.toThrow('connection refused');
  });
});
