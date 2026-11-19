import { AuditAction } from '../../../src/domain/audit/audit-action.enum';
import { Email } from '../../../src/domain/email.value-object';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../src/domain/errors/invalid-access-token.error';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { AuditPageReadModel } from '../../../src/queries/audit-record.read-model';
import { ListAuditRecordsQuery } from '../../../src/queries/list-audit-records.query';
import { AuditRecordRepository } from '../../../src/repositories/audit-record.repository';
import { UserRepository } from '../../../src/repositories/user.repository';
import { ListAuditRecordsService } from '../../../src/services/list-audit-records.service';

const ADMIN_ID = '00000000-0000-4000-8000-00000000000a';

/** A stored caller with the given roles and status. */
function caller(roles: Role[], status = UserStatus.ACTIVE): User {
  return User.restore({
    id: ADMIN_ID,
    customerId: roles.includes(Role.CUSTOMER) ? '00000000-0000-4000-8000-0000000000cc' : null,
    email: Email.create('admin@example.com'),
    name: UserName.create('Admin'),
    passwordHash: '$argon2id$hash',
    roles,
    status,
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    updatedAt: new Date('2026-11-01T10:00:00.000Z'),
    lastLoginAt: null,
  });
}

describe('ListAuditRecordsService', () => {
  let findById: jest.Mock<Promise<User | null>, [string]>;
  let findPage: jest.Mock<Promise<AuditPageReadModel>, [ListAuditRecordsQuery]>;
  let service: ListAuditRecordsService;

  const page: AuditPageReadModel = { items: [], total: 0, limit: 20, offset: 0 };
  const query = new ListAuditRecordsQuery(
    ADMIN_ID,
    20,
    0,
    ADMIN_ID,
    undefined,
    AuditAction.ROLES_CHANGED,
  );

  beforeEach(() => {
    findById = jest.fn<Promise<User | null>, [string]>().mockResolvedValue(caller([Role.ADMIN]));
    findPage = jest
      .fn<Promise<AuditPageReadModel>, [ListAuditRecordsQuery]>()
      .mockResolvedValue(page);
    service = new ListAuditRecordsService(
      { findById } as unknown as UserRepository,
      { findPage } as unknown as AuditRecordRepository,
    );
  });

  it('should re-read the caller and return the repository page for the query', async () => {
    await expect(service.execute(query)).resolves.toBe(page);

    expect(findById).toHaveBeenCalledWith(ADMIN_ID);
    expect(findPage).toHaveBeenCalledWith(query);
  });

  it.each([
    ['missing', null],
    ['disabled', caller([Role.ADMIN], UserStatus.DISABLED)],
    ['no longer an admin', caller([Role.CUSTOMER])],
  ])('should refuse a caller who is %s with USER_UNAVAILABLE', async (_label, stored) => {
    findById.mockResolvedValue(stored);

    await expect(service.execute(query)).rejects.toEqual(
      new InvalidAccessTokenError(AccessTokenFailureReason.USER_UNAVAILABLE),
    );
    expect(findPage).not.toHaveBeenCalled();
  });

  it('should propagate a repository error', async () => {
    findPage.mockRejectedValue(new Error('connection refused'));

    await expect(service.execute(query)).rejects.toThrow('connection refused');
  });
});
