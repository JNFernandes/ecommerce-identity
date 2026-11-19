import { Email } from '../../../src/domain/email.value-object';
import { CannotDisableSelfError } from '../../../src/domain/errors/cannot-disable-self.error';
import { InvalidCredentialsError } from '../../../src/domain/errors/invalid-credentials.error';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { UserRegistered } from '../../../src/domain/events/user-registered.event';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';

describe('User', () => {
  const email = Email.create('Ana@Example.com');
  const name = UserName.create(' Ana Silva ');

  describe('registerCustomer', () => {
    it('should create an ACTIVE customer with the given data', () => {
      const user = User.registerCustomer(email, name, HASH);

      expect(user.id).toMatch(UUID);
      expect(user.customerId).toMatch(UUID);
      expect(user.email.value).toBe('ana@example.com');
      expect(user.name.value).toBe('Ana Silva');
      expect(user.passwordHash).toBe(HASH);
      expect(user.roles).toEqual([Role.CUSTOMER]);
      expect(user.status).toBe(UserStatus.ACTIVE);
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toEqual(user.createdAt);
      expect(user.lastLoginAt).toBeNull();
    });

    it('should give the customer a customerId different from its id', () => {
      const user = User.registerCustomer(email, name, HASH);

      expect(user.customerId).not.toBe(user.id);
    });

    it('should give each user new ids', () => {
      const first = User.registerCustomer(email, name, HASH);
      const second = User.registerCustomer(email, name, HASH);

      expect(second.id).not.toBe(first.id);
      expect(second.customerId).not.toBe(first.customerId);
    });

    it('should record one UserRegistered event that matches the user', () => {
      const user = User.registerCustomer(email, name, HASH);

      const events = user.pullDomainEvents();

      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(UserRegistered);
      expect(events[0]).toEqual({
        eventId: expect.stringMatching(UUID),
        aggregateId: user.id,
        occurredAt: user.createdAt.toISOString(),
        version: 1,
        customerId: user.customerId,
        email: 'ana@example.com',
        name: 'Ana Silva',
      });
    });

    it('should return no event on the second pull', () => {
      const user = User.registerCustomer(email, name, HASH);
      user.pullDomainEvents();

      expect(user.pullDomainEvents()).toEqual([]);
    });

    it('should not expose its roles for mutation', () => {
      const user = User.registerCustomer(email, name, HASH);

      user.roles.push(Role.ADMIN);

      expect(user.roles).toEqual([Role.CUSTOMER]);
    });
  });

  describe('registerAdmin', () => {
    it('should create an ACTIVE admin without a customerId', () => {
      const user = User.registerAdmin(email, name, HASH);

      expect(user.id).toMatch(UUID);
      expect(user.customerId).toBeNull();
      expect(user.email.value).toBe('ana@example.com');
      expect(user.name.value).toBe('Ana Silva');
      expect(user.passwordHash).toBe(HASH);
      expect(user.roles).toEqual([Role.ADMIN]);
      expect(user.status).toBe(UserStatus.ACTIVE);
      expect(user.updatedAt).toEqual(user.createdAt);
      expect(user.lastLoginAt).toBeNull();
      expect(user.canLogin()).toBe(true);
    });

    it('should raise no domain event', () => {
      const user = User.registerAdmin(email, name, HASH);

      expect(user.pullDomainEvents()).toEqual([]);
    });

    it('should give every admin a new id', () => {
      expect(User.registerAdmin(email, name, HASH).id).not.toBe(
        User.registerAdmin(email, name, HASH).id,
      );
    });
  });

  describe('createByAdmin', () => {
    it('should create a customer like registration for exactly [CUSTOMER]', () => {
      const user = User.createByAdmin(email, name, HASH, [Role.CUSTOMER]);

      expect(user.roles).toEqual([Role.CUSTOMER]);
      expect(user.status).toBe(UserStatus.ACTIVE);
      expect(user.customerId).toMatch(UUID);
      expect(user.customerId).not.toBe(user.id);
      expect(user.passwordHash).toBe(HASH);
      expect(user.lastLoginAt).toBeNull();
      const events = user.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(UserRegistered);
      expect(events[0]).toMatchObject({
        aggregateId: user.id,
        customerId: user.customerId,
        email: 'ana@example.com',
        name: 'Ana Silva',
      });
    });

    it('should create an admin without customerId and without event for exactly [ADMIN]', () => {
      const user = User.createByAdmin(email, name, HASH, [Role.ADMIN]);

      expect(user.roles).toEqual([Role.ADMIN]);
      expect(user.status).toBe(UserStatus.ACTIVE);
      expect(user.customerId).toBeNull();
      expect(user.id).toMatch(UUID);
      expect(user.pullDomainEvents()).toEqual([]);
    });

    it.each([
      ['no role', []],
      ['both roles', [Role.CUSTOMER, Role.ADMIN]],
      ['both roles, admin first', [Role.ADMIN, Role.CUSTOMER]],
      ['a repeated role', [Role.ADMIN, Role.ADMIN]],
    ])('should reject %s', (_label, roles) => {
      const error = new UserValidationError('roles must be exactly one of CUSTOMER or ADMIN');
      expect(() => User.createByAdmin(email, name, HASH, roles)).toThrow(error);
      expect(() => User.assertRolesForAdminCreation(roles)).toThrow(error);
    });

    it('should return the single role when the roles are valid', () => {
      expect(User.assertRolesForAdminCreation([Role.ADMIN])).toBe(Role.ADMIN);
      expect(User.assertRolesForAdminCreation([Role.CUSTOMER])).toBe(Role.CUSTOMER);
    });
  });

  describe('restore', () => {
    const props = {
      id: '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b',
      customerId: null,
      email,
      name,
      passwordHash: HASH,
      roles: [Role.ADMIN],
      status: UserStatus.DISABLED,
      createdAt: new Date('2026-11-01T10:00:00.000Z'),
      updatedAt: new Date('2026-11-02T10:00:00.000Z'),
      lastLoginAt: new Date('2026-11-03T10:00:00.000Z'),
    };

    it('should rebuild the user exactly as stored', () => {
      const user = User.restore(props);

      expect(user.id).toBe(props.id);
      expect(user.customerId).toBeNull();
      expect(user.email).toBe(email);
      expect(user.name).toBe(name);
      expect(user.passwordHash).toBe(HASH);
      expect(user.roles).toEqual([Role.ADMIN]);
      expect(user.status).toBe(UserStatus.DISABLED);
      expect(user.createdAt).toEqual(props.createdAt);
      expect(user.updatedAt).toEqual(props.updatedAt);
      expect(user.lastLoginAt).toEqual(props.lastLoginAt);
    });

    it('should raise no event', () => {
      expect(User.restore(props).pullDomainEvents()).toEqual([]);
    });
  });

  describe('login', () => {
    const loginAt = new Date('2026-11-17T12:00:00.000Z');

    function withStatus(status: UserStatus): User {
      const registered = User.registerCustomer(email, name, HASH);
      return User.restore({
        id: registered.id,
        customerId: registered.customerId,
        email,
        name,
        passwordHash: HASH,
        roles: registered.roles,
        status,
        createdAt: new Date('2026-11-01T10:00:00.000Z'),
        updatedAt: new Date('2026-11-02T10:00:00.000Z'),
        lastLoginAt: null,
      });
    }

    it('should let an ACTIVE user log in and record the time', () => {
      const user = withStatus(UserStatus.ACTIVE);

      expect(user.canLogin()).toBe(true);
      user.recordLogin(loginAt);

      expect(user.lastLoginAt).toEqual(loginAt);
    });

    it('should leave updatedAt unchanged on login', () => {
      const user = withStatus(UserStatus.ACTIVE);

      user.recordLogin(loginAt);

      expect(user.updatedAt).toEqual(new Date('2026-11-02T10:00:00.000Z'));
    });

    it('should refuse a DISABLED user and keep lastLoginAt null', () => {
      const user = withStatus(UserStatus.DISABLED);

      expect(user.canLogin()).toBe(false);
      expect(() => user.recordLogin(loginAt)).toThrow(InvalidCredentialsError);
      expect(user.lastLoginAt).toBeNull();
    });
  });

  describe('status changes', () => {
    const CREATED_AT = new Date('2026-11-01T10:00:00.000Z');
    const UPDATED_AT = new Date('2026-11-02T10:00:00.000Z');
    const LAST_LOGIN_AT = new Date('2026-11-03T10:00:00.000Z');
    const AT = new Date('2026-11-18T12:00:00.000Z');
    const ADMIN_ID = '00000000-0000-4000-8000-000000000001';

    function stored(status: UserStatus, roles: Role[] = [Role.CUSTOMER]): User {
      const registered = User.registerCustomer(email, name, HASH);
      return User.restore({
        id: registered.id,
        customerId: roles.includes(Role.CUSTOMER) ? registered.customerId : null,
        email,
        name,
        passwordHash: HASH,
        roles,
        status,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        lastLoginAt: LAST_LOGIN_AT,
      });
    }

    function untouchedFields(user: User): unknown {
      return {
        id: user.id,
        customerId: user.customerId,
        email: user.email.value,
        name: user.name.value,
        passwordHash: user.passwordHash,
        roles: user.roles,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      };
    }

    describe('disable', () => {
      it('should disable an ACTIVE user, set updatedAt and return true', () => {
        const user = stored(UserStatus.ACTIVE);
        const before = untouchedFields(user);

        expect(user.disable(ADMIN_ID, AT)).toBe(true);

        expect(user.status).toBe(UserStatus.DISABLED);
        expect(user.updatedAt).toEqual(AT);
        expect(user.canLogin()).toBe(false);
        expect(untouchedFields(user)).toEqual(before);
      });

      it('should change nothing and return false for a DISABLED user', () => {
        const user = stored(UserStatus.DISABLED);
        const before = untouchedFields(user);

        expect(user.disable(ADMIN_ID, AT)).toBe(false);

        expect(user.status).toBe(UserStatus.DISABLED);
        expect(user.updatedAt).toEqual(UPDATED_AT);
        expect(untouchedFields(user)).toEqual(before);
      });

      it('should refuse an admin disabling their own account', () => {
        const user = stored(UserStatus.ACTIVE, [Role.ADMIN]);

        expect(() => user.disable(user.id, AT)).toThrow(CannotDisableSelfError);
        expect(user.status).toBe(UserStatus.ACTIVE);
        expect(user.updatedAt).toEqual(UPDATED_AT);
      });

      it('should refuse a self-disable even when the user is already DISABLED', () => {
        const user = stored(UserStatus.DISABLED, [Role.ADMIN]);

        expect(() => user.disable(user.id, AT)).toThrow(CannotDisableSelfError);
        expect(user.updatedAt).toEqual(UPDATED_AT);
      });
    });

    describe('assertCanBeDisabledBy', () => {
      it('should throw for the user itself and change nothing', () => {
        const user = stored(UserStatus.ACTIVE, [Role.ADMIN]);

        expect(() => user.assertCanBeDisabledBy(user.id)).toThrow(CannotDisableSelfError);
        expect(user.status).toBe(UserStatus.ACTIVE);
      });

      it('should pass for another admin and change nothing', () => {
        const user = stored(UserStatus.ACTIVE);

        expect(() => user.assertCanBeDisabledBy(ADMIN_ID)).not.toThrow();
        expect(user.status).toBe(UserStatus.ACTIVE);
        expect(user.updatedAt).toEqual(UPDATED_AT);
      });
    });

    describe('enable', () => {
      it('should enable a DISABLED user, set updatedAt and return true', () => {
        const user = stored(UserStatus.DISABLED);
        const before = untouchedFields(user);

        expect(user.enable(AT)).toBe(true);

        expect(user.status).toBe(UserStatus.ACTIVE);
        expect(user.updatedAt).toEqual(AT);
        expect(user.canLogin()).toBe(true);
        expect(untouchedFields(user)).toEqual(before);
      });

      it('should change nothing and return false for an ACTIVE user', () => {
        const user = stored(UserStatus.ACTIVE);
        const before = untouchedFields(user);

        expect(user.enable(AT)).toBe(false);

        expect(user.status).toBe(UserStatus.ACTIVE);
        expect(user.updatedAt).toEqual(UPDATED_AT);
        expect(untouchedFields(user)).toEqual(before);
      });
    });

    describe('changePassword', () => {
      const NEW_HASH = '$argon2id$v=19$m=65536,t=3,p=4$bmV3c2FsdA$bmV3aGFzaA';

      it.each([[[Role.CUSTOMER]], [[Role.ADMIN]], [[Role.CUSTOMER, Role.ADMIN]]])(
        'should return a user with only the hash and updatedAt replaced (roles %j)',
        (roles) => {
          const user = stored(UserStatus.ACTIVE, roles);

          const changed = user.changePassword(NEW_HASH, AT);

          expect(changed.passwordHash).toBe(NEW_HASH);
          expect(changed.updatedAt).toEqual(AT);
          expect(changed.status).toBe(UserStatus.ACTIVE);
          expect(untouchedFields(changed)).toEqual({
            ...(untouchedFields(user) as object),
            passwordHash: NEW_HASH,
          });
        },
      );

      it('should leave the original instance untouched', () => {
        const user = stored(UserStatus.ACTIVE);
        const before = { ...(untouchedFields(user) as object), updatedAt: user.updatedAt };

        const changed = user.changePassword(NEW_HASH, AT);

        expect(changed).not.toBe(user);
        expect({ ...(untouchedFields(user) as object), updatedAt: user.updatedAt }).toEqual(before);
      });

      it('should refuse a DISABLED user with the generic credentials error', () => {
        expect(() => stored(UserStatus.DISABLED).changePassword(NEW_HASH, AT)).toThrow(
          InvalidCredentialsError,
        );
      });

      it('should raise no domain event', () => {
        expect(stored(UserStatus.ACTIVE).changePassword(NEW_HASH, AT).pullDomainEvents()).toEqual(
          [],
        );
      });
    });

    describe('isActiveAdmin', () => {
      it.each([
        ['an ACTIVE admin', UserStatus.ACTIVE, [Role.ADMIN], true],
        ['a DISABLED admin', UserStatus.DISABLED, [Role.ADMIN], false],
        ['an ACTIVE customer', UserStatus.ACTIVE, [Role.CUSTOMER], false],
      ])('should tell whether %s is an active admin', (_label, status, roles, expected) => {
        expect(stored(status, roles).isActiveAdmin()).toBe(expected);
      });
    });
  });
});
