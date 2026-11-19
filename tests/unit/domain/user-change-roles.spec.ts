import { Email } from '../../../src/domain/email.value-object';
import { CannotRemoveOwnAdminError } from '../../../src/domain/errors/cannot-remove-own-admin.error';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { UserRegistered } from '../../../src/domain/events/user-registered.event';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';

const UPDATED_AT = new Date('2026-11-02T10:00:00.000Z');
const AT = new Date('2026-11-19T12:00:00.000Z');
const ACTOR = '00000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';

/** A stored user with the given roles and customer id. */
function stored(roles: Role[], customerId: string | null): User {
  const registered = User.registerAdmin(
    Email.create('ana@example.com'),
    UserName.create('Ana'),
    'hash',
  );
  return User.restore({
    id: registered.id,
    customerId,
    email: registered.email,
    name: registered.name,
    passwordHash: 'hash',
    roles,
    status: UserStatus.ACTIVE,
    createdAt: registered.createdAt,
    updatedAt: UPDATED_AT,
    lastLoginAt: null,
  });
}

describe('User.changeRoles', () => {
  it('should grant ADMIN to a customer and keep the customerId, without event', () => {
    const user = stored([Role.CUSTOMER], CUSTOMER_ID);

    const result = user.changeRoles([Role.CUSTOMER, Role.ADMIN], ACTOR, AT);

    expect(result).toEqual({ changed: true, removed: [], customerCreated: false });
    expect(user.roles).toEqual([Role.CUSTOMER, Role.ADMIN]);
    expect(user.customerId).toBe(CUSTOMER_ID);
    expect(user.updatedAt).toBe(AT);
    expect(user.pullDomainEvents()).toEqual([]);
  });

  it('should treat the same set of roles in any order as a no-op', () => {
    const user = stored([Role.CUSTOMER, Role.ADMIN], CUSTOMER_ID);

    const result = user.changeRoles([Role.ADMIN, Role.CUSTOMER], ACTOR, AT);

    expect(result).toEqual({ changed: false, removed: [], customerCreated: false });
    expect(user.updatedAt).toBe(UPDATED_AT);
  });

  it('should check the no-op before the self rule', () => {
    const user = stored([Role.ADMIN], null);

    expect(user.changeRoles([Role.ADMIN], user.id, AT).changed).toBe(false);
  });

  it('should report the removed roles', () => {
    const user = stored([Role.CUSTOMER, Role.ADMIN], CUSTOMER_ID);

    expect(user.changeRoles([Role.CUSTOMER], ACTOR, AT).removed).toEqual([Role.ADMIN]);
  });

  it('should refuse an admin removing their own ADMIN role and change nothing', () => {
    const user = stored([Role.ADMIN], null);

    expect(() => user.changeRoles([Role.CUSTOMER], user.id, AT)).toThrow(CannotRemoveOwnAdminError);
    expect(user.roles).toEqual([Role.ADMIN]);
    expect(user.customerId).toBeNull();
  });

  it('should let an admin add CUSTOMER to themselves', () => {
    const user = stored([Role.ADMIN], null);

    expect(user.changeRoles([Role.ADMIN, Role.CUSTOMER], user.id, AT).changed).toBe(true);
  });

  it('should create a customerId and record UserRegistered on the first CUSTOMER grant', () => {
    const user = stored([Role.ADMIN], null);

    const result = user.changeRoles([Role.ADMIN, Role.CUSTOMER], ACTOR, AT);

    expect(result.customerCreated).toBe(true);
    expect(user.customerId).toEqual(expect.any(String));
    expect(user.customerId).not.toBe(user.id);
    const events = user.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(UserRegistered);
    expect(events[0]).toMatchObject({
      aggregateId: user.id,
      customerId: user.customerId,
      email: 'ana@example.com',
      name: 'Ana',
      occurredAt: AT.toISOString(),
    });
  });

  it('should reuse an existing customerId on a re-grant, without event', () => {
    const user = stored([Role.ADMIN], CUSTOMER_ID);

    const result = user.changeRoles([Role.CUSTOMER], ACTOR, AT);

    expect(result.customerCreated).toBe(false);
    expect(user.customerId).toBe(CUSTOMER_ID);
    expect(user.pullDomainEvents()).toEqual([]);
  });

  it('should keep the customerId when CUSTOMER is removed, but hide it as dormant', () => {
    const user = stored([Role.CUSTOMER, Role.ADMIN], CUSTOMER_ID);

    user.changeRoles([Role.ADMIN], ACTOR, AT);

    expect(user.customerId).toBe(CUSTOMER_ID);
    expect(user.activeCustomerId).toBeNull();
  });

  it('should expose the customerId as active while the roles include CUSTOMER', () => {
    expect(stored([Role.CUSTOMER], CUSTOMER_ID).activeCustomerId).toBe(CUSTOMER_ID);
  });

  it.each([
    ['empty', []],
    ['repeated', [Role.ADMIN, Role.ADMIN]],
    ['unknown', ['OWNER' as Role]],
  ])('should refuse %s roles', (_label, roles) => {
    const user = stored([Role.CUSTOMER], CUSTOMER_ID);

    expect(() => user.changeRoles(roles, ACTOR, AT)).toThrow(UserValidationError);
    expect(user.roles).toEqual([Role.CUSTOMER]);
  });

  it('should keep its own copy of the requested roles', () => {
    const user = stored([Role.CUSTOMER], CUSTOMER_ID);
    const roles = [Role.ADMIN];

    user.changeRoles(roles, ACTOR, AT);
    roles.push(Role.CUSTOMER);

    expect(user.roles).toEqual([Role.ADMIN]);
  });
});
