import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ChangeUserStatusCommand } from '../commands/change-user-status.command';
import { AuthenticatedPrincipal } from '../domain/authenticated-principal';
import { CannotDisableSelfError } from '../domain/errors/cannot-disable-self.error';
import { LastActiveAdminError } from '../domain/errors/last-active-admin.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import { Role } from '../domain/role.enum';
import { ChangeUserStatusDto } from '../dto/change-user-status.dto';
import { CurrentUserResponseDto } from '../dto/current-user-response.dto';
import { ListUsersQueryDto } from '../dto/list-users-query.dto';
import { UserPageResponseDto } from '../dto/user-page-response.dto';
import { UserSummaryResponseDto } from '../dto/user-summary-response.dto';
import { GetCurrentUserQuery } from '../queries/get-current-user.query';
import { GetUserQuery } from '../queries/get-user.query';
import { ListUsersQuery } from '../queries/list-users.query';
import { UserPageReadModel, UserSummaryReadModel } from '../queries/user-summary.read-model';
import { CurrentUserReadModel } from '../services/get-current-user.service';
import { CurrentUser } from './auth/current-user.decorator';
import { Roles } from './auth/roles.decorator';

/** Endpoints about users: the caller's own account, and the admin views of every account. */
@ApiTags('users')
@Controller('users')
export class UsersController {
  /**
   * @param queryBus Dispatches the read queries.
   * @param commandBus Dispatches the status change command.
   */
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

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

  /**
   * Returns one user for admins, in the list item shape. Declared after `GET /users/me`, which
   * therefore keeps its own handler; `me` is not a UUID anyway.
   *
   * @param id The user id; a malformed id is rejected with 400 by `ParseUUIDPipe`.
   * @throws NotFoundException When no user has this id.
   */
  @Get(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Get one user',
    description: 'Admins only. One user, with the same fields as a `GET /users` item.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id' })
  @ApiOkResponse({ type: UserSummaryResponseDto })
  @ApiBadRequestResponse({ description: '`id` is not a UUID' })
  @ApiNotFoundResponse({ description: 'No user has this id' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserSummaryResponseDto> {
    try {
      const user = await this.queryBus.execute<GetUserQuery, UserSummaryReadModel>(
        new GetUserQuery(id),
      );
      return UserSummaryResponseDto.from(user);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  /**
   * Sets a user's status for admins. Disabling revokes every refresh token of the user in the same
   * transaction; enabling restores login but leaves revoked tokens revoked. Setting the current
   * status is a no-op that still returns 200.
   *
   * @param id The user id; a malformed id is rejected with 400 by `ParseUUIDPipe`.
   * @param dto The requested status, already validated.
   * @param principal The acting admin.
   * @throws NotFoundException When no user has this id.
   * @throws ConflictException When the admin disables their own account or the last active admin.
   */
  @Patch(':id/status')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Enable or disable a user',
    description:
      'Admins only. `DISABLED` blocks login, refresh and `GET /users/me` at once and revokes ' +
      'every refresh token of the user; access tokens already issued stay valid on token-only ' +
      'routes until they expire. `ACTIVE` restores login; revoked tokens stay revoked. Setting ' +
      'the current status changes nothing. An admin cannot disable their own account, and the ' +
      'last active admin cannot be disabled. No event is published.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id' })
  @ApiOkResponse({ type: UserSummaryResponseDto, description: 'The user after the request' })
  @ApiBadRequestResponse({
    description:
      '`id` is not a UUID, `status` is missing or not `ACTIVE`/`DISABLED`, an unknown field ' +
      'was sent, or the body is not valid JSON',
  })
  @ApiNotFoundResponse({ description: 'No user has this id' })
  @ApiConflictResponse({
    description: 'The admin targets their own account, or the target is the last active admin',
  })
  async changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeUserStatusDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<UserSummaryResponseDto> {
    try {
      const user = await this.commandBus.execute<ChangeUserStatusCommand, UserSummaryReadModel>(
        new ChangeUserStatusCommand(id, dto.status, principal.userId),
      );
      return UserSummaryResponseDto.from(user);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof CannotDisableSelfError || error instanceof LastActiveAdminError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}
