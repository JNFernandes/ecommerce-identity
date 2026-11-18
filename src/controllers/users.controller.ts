import { Controller, Get } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedPrincipal } from '../domain/authenticated-principal';
import { Role } from '../domain/role.enum';
import { CurrentUserResponseDto } from '../dto/current-user-response.dto';
import { GetCurrentUserQuery } from '../queries/get-current-user.query';
import { CurrentUserReadModel } from '../services/get-current-user.service';
import { CurrentUser } from './auth/current-user.decorator';
import { Roles } from './auth/roles.decorator';

/** Endpoints about the authenticated user. */
@ApiTags('users')
@Controller('users')
export class UsersController {
  /** @param queryBus Dispatches the read queries. */
  constructor(private readonly queryBus: QueryBus) {}

  /**
   * Returns the caller's account as stored now. The user id comes only from the verified token.
   *
   * @param principal The caller.
   */
  @Get('me')
  @Roles(Role.CUSTOMER, Role.ADMIN)
  @ApiOperation({
    summary: 'Current user',
    description:
      'Returns the stored account of the access token user. `customerId` is left out for admins. ' +
      'A missing or disabled user gets the same 401 as an invalid token.',
  })
  @ApiOkResponse({ type: CurrentUserResponseDto })
  async me(@CurrentUser() principal: AuthenticatedPrincipal): Promise<CurrentUserResponseDto> {
    const model = await this.queryBus.execute<GetCurrentUserQuery, CurrentUserReadModel>(
      new GetCurrentUserQuery(principal.userId),
    );
    return CurrentUserResponseDto.from(model);
  }
}
