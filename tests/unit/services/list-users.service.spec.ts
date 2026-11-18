import { Role } from '../../../src/domain/role.enum';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { ListUsersQuery } from '../../../src/queries/list-users.query';
import { UserPageReadModel } from '../../../src/queries/user-summary.read-model';
import { UserRepository } from '../../../src/repositories/user.repository';
import { ListUsersService } from '../../../src/services/list-users.service';

describe('ListUsersService', () => {
  let findPage: jest.Mock<Promise<UserPageReadModel>, [ListUsersQuery]>;
  let service: ListUsersService;

  const page: UserPageReadModel = {
    items: [
      {
        id: 'u1',
        customerId: 'c1',
        email: 'ana@example.com',
        name: 'Ana',
        roles: [Role.CUSTOMER],
        status: UserStatus.ACTIVE,
        createdAt: new Date('2026-11-18T10:00:00.000Z'),
        lastLoginAt: null,
      },
    ],
    total: 7,
    limit: 1,
    offset: 3,
  };

  beforeEach(() => {
    findPage = jest.fn<Promise<UserPageReadModel>, [ListUsersQuery]>().mockResolvedValue(page);
    service = new ListUsersService({ findPage } as unknown as UserRepository);
  });

  it('should pass the paging and filters to the repository unchanged', async () => {
    const query = new ListUsersQuery(1, 3, Role.CUSTOMER, UserStatus.ACTIVE, 'an');

    await service.execute(query);

    expect(findPage).toHaveBeenCalledTimes(1);
    expect(findPage).toHaveBeenCalledWith(query);
  });

  it('should return the repository page', async () => {
    await expect(service.execute(new ListUsersQuery(1, 3))).resolves.toBe(page);
  });

  it('should propagate a repository error', async () => {
    findPage.mockRejectedValue(new Error('connection refused'));

    await expect(service.execute(new ListUsersQuery(20, 0))).rejects.toThrow('connection refused');
  });
});
