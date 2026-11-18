import { Controller, Get, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedPrincipal } from '../domain/authenticated-principal';
import { Role } from '../domain/role.enum';
import { CurrentUserResponseDto } from '../dto/current-user-response.dto';
import { ListUsersQueryDto } from '../dto/list-users-query.dto';
import { UserPageResponseDto } from '../dto/user-page-response.dto';
import { GetCurrentUserQuery } from '../queries/get-current-user.query';
import { ListUsersQuery } from '../queries/list-users.query';
import { UserPageReadModel } from '../queries/user-summary.read-model';
import { CurrentUserReadModel } from '../services/get-current-user.service';
import { CurrentUser } from './auth/current-user.decorator';
import { Roles } from './auth/roles.decorator';

/** Endpoints about users: the caller's own account, and the admin views of every account. */
@ApiTags('users')
@Controller('users')
export class UsersController {
  /** @param queryBus Dispatches the read queries. */
  constructor(private readonly queryBus: QueryBus) {}

  /**
   * Lists users for admins, newest first, optionally filtered by role, status and email prefix.
   *
   * @param query Paging and filters, already validated.
   */
  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'List users',
    description:
      'Admins only. One page of users, newest first (`createdAt` desc, then `id`). Filters ' +
      'combine with AND; `email` is a case-insensitive prefix matched literally. `total` counts ' +
      'every matching user. An offset past the end returns no items with the real total.',
  })
  @ApiOkResponse({ type: UserPageResponseDto })
  @ApiBadRequestResponse({
    description:
      'Invalid or out-of-range parameter, or an unknown parameter; `message` lists the problems',
  })
  async list(@Query() query: ListUsersQueryDto): Promise<UserPageResponseDto> {
    const page = await this.queryBus.execute<ListUsersQuery, UserPageReadModel>(
      new ListUsersQuery(query.limit, query.offset, query.role, query.status, query.email),
    );
    return UserPageResponseDto.from(page);
  }

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
