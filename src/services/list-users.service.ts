import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { ListUsersQuery } from '../queries/list-users.query';
import { UserPageReadModel } from '../queries/user-summary.read-model';
import { UserRepository } from '../repositories/user.repository';

/**
 * Handles `ListUsersQuery` (`GET /users`, admins only): reads one filtered page of users, newest
 * first. Read-only; database errors propagate (5xx, never an empty page).
 */
@QueryHandler(ListUsersQuery)
export class ListUsersService implements IQueryHandler<ListUsersQuery, UserPageReadModel> {
  /** @param users Reads the users. */
  constructor(private readonly users: UserRepository) {}

  /**
   * Returns the requested page.
   *
   * @param query Paging and filters.
   */
  execute(query: ListUsersQuery): Promise<UserPageReadModel> {
    return this.users.findPage(query);
  }
}
