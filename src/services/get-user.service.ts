import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import { GetUserQuery } from '../queries/get-user.query';
import { UserSummaryReadModel } from '../queries/user-summary.read-model';
import { UserRepository } from '../repositories/user.repository';

/**
 * Handles `GetUserQuery` (`GET /users/{id}`, admins only): reads one user in the list item shape.
 * Read-only; database errors propagate (5xx, never 404).
 */
@QueryHandler(GetUserQuery)
export class GetUserService implements IQueryHandler<GetUserQuery, UserSummaryReadModel> {
  /** @param users Reads the user. */
  constructor(private readonly users: UserRepository) {}

  /**
   * Returns the user with the given id.
   *
   * @param query The user id.
   * @throws UserNotFoundError When no user has this id.
   */
  async execute(query: GetUserQuery): Promise<UserSummaryReadModel> {
    const user = await this.users.findSummaryById(query.id);
    if (user === null) {
      throw new UserNotFoundError();
    }
    return user;
  }
}
