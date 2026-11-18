import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../domain/errors/invalid-access-token.error';
import { Role } from '../domain/role.enum';
import { UserStatus } from '../domain/user-status.enum';
import { GetCurrentUserQuery } from '../queries/get-current-user.query';
import { UserRepository } from '../repositories/user.repository';

/**
 * The caller's account as stored now. Carries no password hash, `updatedAt` or `lastLoginAt`.
 */
export interface CurrentUserReadModel {
  /** User id. */
  id: string;
  /** Customer id; `null` for admins. */
  customerId: string | null;
  /** Normalized email. */
  email: string;
  /** Display name. */
  name: string;
  /** Current stored roles (not the token's). */
  roles: Role[];
  /** Account status; always `ACTIVE` when returned. */
  status: UserStatus;
  /** Creation time. */
  createdAt: Date;
}

/**
 * Handles `GetCurrentUserQuery`: reads the user fresh from the database. A missing user, or one who
 * may no longer log in, is refused like an invalid token. Database errors propagate (5xx, never 401).
 */
@QueryHandler(GetCurrentUserQuery)
export class GetCurrentUserService implements IQueryHandler<
  GetCurrentUserQuery,
  CurrentUserReadModel
> {
  /** @param users Reads the user by id. */
  constructor(private readonly users: UserRepository) {}

  /**
   * Returns the caller's account.
   *
   * @param query The user id from the verified token.
   * @throws InvalidAccessTokenError `USER_UNAVAILABLE` when the user is missing or not `ACTIVE`.
   */
  async execute(query: GetCurrentUserQuery): Promise<CurrentUserReadModel> {
    const user = await this.users.findById(query.userId);
    if (user === null || !user.canLogin()) {
      throw new InvalidAccessTokenError(AccessTokenFailureReason.USER_UNAVAILABLE);
    }
    return {
      id: user.id,
      customerId: user.customerId,
      email: user.email.value,
      name: user.name.value,
      roles: [...user.roles],
      status: user.status,
      createdAt: user.createdAt,
    };
  }
}
