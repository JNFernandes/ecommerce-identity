import { AuthenticatedPrincipal } from '../../../src/domain/authenticated-principal';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../src/domain/errors/invalid-access-token.error';
import { Role } from '../../../src/domain/role.enum';

const USER_ID = '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const CUSTOMER_ID = 'a2d4e6f8-0b1c-4d2e-8f3a-5b6c7d8e9f0a';

function expectInvalidClaims(claims: unknown): void {
  let caught: unknown;
  try {
    AuthenticatedPrincipal.fromClaims(claims);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidAccessTokenError);
  expect((caught as InvalidAccessTokenError).reason).toBe(AccessTokenFailureReason.INVALID_CLAIMS);
}

describe('AuthenticatedPrincipal', () => {
  describe('fromClaims', () => {
    it('should build a customer principal', () => {
      const principal = AuthenticatedPrincipal.fromClaims({
        sub: USER_ID,
        roles: ['CUSTOMER'],
        customerId: CUSTOMER_ID,
        jti: 'x',
      });

      expect(principal.userId).toBe(USER_ID);
      expect(principal.roles).toEqual([Role.CUSTOMER]);
      expect(principal.customerId).toBe(CUSTOMER_ID);
    });

    it('should give an admin without customerId a null customerId', () => {
      const principal = AuthenticatedPrincipal.fromClaims({ sub: USER_ID, roles: ['ADMIN'] });

      expect(principal.roles).toEqual([Role.ADMIN]);
      expect(principal.customerId).toBeNull();
    });

    it('should remove duplicate roles', () => {
      const principal = AuthenticatedPrincipal.fromClaims({
        sub: USER_ID,
        roles: ['ADMIN', 'CUSTOMER', 'ADMIN'],
        customerId: CUSTOMER_ID,
      });

      expect(principal.roles).toEqual([Role.ADMIN, Role.CUSTOMER]);
    });

    it('should be immutable', () => {
      const principal = AuthenticatedPrincipal.fromClaims({ sub: USER_ID, roles: ['ADMIN'] });

      expect(Object.isFrozen(principal)).toBe(true);
      expect(Object.isFrozen(principal.roles)).toBe(true);
    });

    it.each([null, undefined, 'claims', 42, ['CUSTOMER']])(
      'should reject non-object claims %p',
      (claims) => {
        expectInvalidClaims(claims);
      },
    );

    it.each([undefined, '', 42, null])('should reject a sub of %p', (sub) => {
      expectInvalidClaims({ sub, roles: ['CUSTOMER'], customerId: CUSTOMER_ID });
    });

    it.each([undefined, [], 'CUSTOMER', ['CUSTOMER', 'ROOT'], ['customer'], [42], null])(
      'should reject roles of %p',
      (roles) => {
        expectInvalidClaims({ sub: USER_ID, roles, customerId: CUSTOMER_ID });
      },
    );

    it.each(['', 42, null, {}])('should reject a customerId of %p', (customerId) => {
      expectInvalidClaims({ sub: USER_ID, roles: ['CUSTOMER'], customerId });
    });
  });

  describe('hasAnyRole', () => {
    const customer = AuthenticatedPrincipal.fromClaims({
      sub: USER_ID,
      roles: ['CUSTOMER'],
      customerId: CUSTOMER_ID,
    });

    it('should return true when a role overlaps', () => {
      expect(customer.hasAnyRole([Role.CUSTOMER, Role.ADMIN])).toBe(true);
    });

    it('should return false when no role overlaps', () => {
      expect(customer.hasAnyRole([Role.ADMIN])).toBe(false);
      expect(customer.hasAnyRole([])).toBe(false);
    });
  });
});
