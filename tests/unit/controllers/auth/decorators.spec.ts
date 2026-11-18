import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedPrincipal } from '../../../../src/domain/authenticated-principal';
import { Role } from '../../../../src/domain/role.enum';
import { currentUserFactory } from '../../../../src/controllers/auth/current-user.decorator';
import { IS_PUBLIC_KEY, Public } from '../../../../src/controllers/auth/public.decorator';
import { Roles, ROLES_KEY } from '../../../../src/controllers/auth/roles.decorator';

@Public()
class PublicController {
  handler(): void {}
}

class MixedController {
  @Public()
  open(): void {}

  @Roles(Role.CUSTOMER, Role.ADMIN)
  restricted(): void {}
}

@Roles(Role.ADMIN)
class AdminController {
  handler(): void {}
}

describe('access control decorators', () => {
  const reflector = new Reflector();

  it('should mark a whole controller public', () => {
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, PublicController)).toBe(true);
  });

  it('should mark a single handler public', () => {
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, MixedController.prototype.open)).toBe(true);
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, MixedController.prototype.restricted)).toBe(
      undefined,
    );
  });

  it('should store the roles on a handler', () => {
    expect(reflector.get<Role[]>(ROLES_KEY, MixedController.prototype.restricted)).toEqual([
      Role.CUSTOMER,
      Role.ADMIN,
    ]);
  });

  it('should store the roles on a controller', () => {
    expect(reflector.get<Role[]>(ROLES_KEY, AdminController)).toEqual([Role.ADMIN]);
  });

  it('should make CurrentUser return the principal of the request', () => {
    const principal = AuthenticatedPrincipal.fromClaims({ sub: 'user-1', roles: ['ADMIN'] });
    const context = {
      switchToHttp: (): object => ({ getRequest: (): object => ({ principal }) }),
    } as unknown as ExecutionContext;

    expect(currentUserFactory(undefined, context)).toBe(principal);
  });
});
