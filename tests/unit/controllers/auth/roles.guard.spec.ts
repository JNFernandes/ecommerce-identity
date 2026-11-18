import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public } from '../../../../src/controllers/auth/public.decorator';
import { Roles } from '../../../../src/controllers/auth/roles.decorator';
import { RolesGuard } from '../../../../src/controllers/auth/roles.guard';
import { AuthenticatedPrincipal } from '../../../../src/domain/authenticated-principal';
import { Role } from '../../../../src/domain/role.enum';

class TestController {
  @Public()
  open(): void {}

  @Roles(Role.ADMIN)
  adminOnly(): void {}

  @Roles(Role.CUSTOMER, Role.ADMIN)
  anyUser(): void {}

  undeclared(): void {}
}

function contextFor(handler: () => void, principal?: AuthenticatedPrincipal): ExecutionContext {
  return {
    getHandler: (): (() => void) => handler,
    getClass: (): typeof TestController => TestController,
    switchToHttp: (): object => ({ getRequest: (): object => ({ principal }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const customer = AuthenticatedPrincipal.fromClaims({
    sub: 'user-1',
    roles: ['CUSTOMER'],
    customerId: 'customer-1',
  });

  function forbiddenBody(handler: () => void): unknown {
    try {
      guard.canActivate(contextFor(handler, customer));
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      return (error as ForbiddenException).getResponse();
    }
    throw new Error('expected ForbiddenException');
  }

  it('should let a public route through without a principal', () => {
    expect(guard.canActivate(contextFor(TestController.prototype.open))).toBe(true);
  });

  it('should let a principal with a matching role through', () => {
    expect(guard.canActivate(contextFor(TestController.prototype.anyUser, customer))).toBe(true);
  });

  it('should refuse a role mismatch with the generic 403', () => {
    expect(forbiddenBody(TestController.prototype.adminOnly)).toEqual({
      statusCode: 403,
      message: 'forbidden',
      error: 'Forbidden',
    });
  });

  it('should refuse a route without roles', () => {
    expect(forbiddenBody(TestController.prototype.undeclared)).toMatchObject({
      statusCode: 403,
    });
  });
});
