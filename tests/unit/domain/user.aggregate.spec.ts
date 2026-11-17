import { Email } from '../../../src/domain/email.value-object';
import { InvalidCredentialsError } from '../../../src/domain/errors/invalid-credentials.error';
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
});
