import { Role } from '../domain/role.enum';
import { UserStatus } from '../domain/user-status.enum';

/**
 * Query for one page of users (`GET /users`), newest first. The filters combine with AND; an
 * absent filter matches every user.
 */
export class ListUsersQuery {
  /**
   * @param limit Page size, 1–100.
   * @param offset Number of matching users to skip, ≥ 0.
   * @param role Only users holding this role.
   * @param status Only users with this status.
   * @param emailPrefix Only users whose email starts with this text, ignoring case; matched
   * literally (`%` and `_` are not wildcards).
   */
  constructor(
    readonly limit: number,
    readonly offset: number,
    readonly role?: Role,
    readonly status?: UserStatus,
    readonly emailPrefix?: string,
  ) {}
}
