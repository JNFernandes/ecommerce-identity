import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../../src/controllers/auth/current-user.decorator';
import { Roles } from '../../../src/controllers/auth/roles.decorator';
import { AuthenticatedPrincipal } from '../../../src/domain/authenticated-principal';
import { Role } from '../../../src/domain/role.enum';

/** What the probe returns: the principal the handler received. */
export interface AdminProbeResponse {
  userId: string;
  roles: readonly Role[];
}

/**
 * Test-only `ADMIN` route, mounted through `createTestApp({ extraControllers })`. Never shipped;
 * removed when real admin routes exist.
 */
@Controller('test')
export class AdminProbeController {
  /**
   * Echoes the caller.
   *
   * @param principal The authenticated admin.
   */
  @Get('admin-probe')
  @Roles(Role.ADMIN)
  probe(@CurrentUser() principal: AuthenticatedPrincipal): AdminProbeResponse {
    return { userId: principal.userId, roles: principal.roles };
  }
}
