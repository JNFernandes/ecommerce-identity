import { Email } from '../../../src/domain/email.value-object';
import { LastActiveAdminError } from '../../../src/domain/errors/last-active-admin.error';
import { LastActiveAdminPolicy } from '../../../src/domain/last-active-admin-policy';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';

/** A stored user with the given role and status. */
function user(role: Role, status: UserStatus): User {
  const registered = User.registerAdmin(
    Email.create('someone@example.com'),
    UserName.create('Someone'),
    '$argon2id$hash',
  );
  return User.restore({
    id: registered.id,
    customerId: null,
    email: registered.email,
    name: registered.name,
    passwordHash: registered.passwordHash,
    roles: [role],
    status,
    createdAt: registered.createdAt,
    updatedAt: registered.updatedAt,
    lastLoginAt: null,
  });
}

describe('LastActiveAdminPolicy', () => {
  it.each([1, 0])('should refuse an ACTIVE admin when the count is %i', (activeAdminCount) => {
    expect(() =>
      LastActiveAdminPolicy.assertCanDisable({
        target: user(Role.ADMIN, UserStatus.ACTIVE),
        activeAdminCount,
      }),
    ).toThrow(LastActiveAdminError);
  });

  it('should allow an ACTIVE admin when another ACTIVE admin exists', () => {
    expect(() =>
      LastActiveAdminPolicy.assertCanDisable({
        target: user(Role.ADMIN, UserStatus.ACTIVE),
        activeAdminCount: 2,
      }),
    ).not.toThrow();
  });

  it.each([
    ['a customer', Role.CUSTOMER, UserStatus.ACTIVE],
    ['a DISABLED admin', Role.ADMIN, UserStatus.DISABLED],
  ])('should allow %s whatever the count', (_label, role, status) => {
    expect(() =>
      LastActiveAdminPolicy.assertCanDisable({ target: user(role, status), activeAdminCount: 1 }),
    ).not.toThrow();
  });
});

describe('LastActiveAdminPolicy.assertCanRemoveAdmin', () => {
  it.each([1, 0])('should refuse an ACTIVE admin when the count is %i', (activeAdminCount) => {
    expect(() =>
      LastActiveAdminPolicy.assertCanRemoveAdmin({
        target: user(Role.ADMIN, UserStatus.ACTIVE),
        activeAdminCount,
      }),
    ).toThrow(new LastActiveAdminError('the last active admin cannot lose the ADMIN role'));
  });

  it('should allow an ACTIVE admin when another ACTIVE admin exists', () => {
    expect(() =>
      LastActiveAdminPolicy.assertCanRemoveAdmin({
        target: user(Role.ADMIN, UserStatus.ACTIVE),
        activeAdminCount: 2,
      }),
    ).not.toThrow();
  });

  it('should allow a DISABLED admin whatever the count', () => {
    expect(() =>
      LastActiveAdminPolicy.assertCanRemoveAdmin({
        target: user(Role.ADMIN, UserStatus.DISABLED),
        activeAdminCount: 1,
      }),
    ).not.toThrow();
  });
});
