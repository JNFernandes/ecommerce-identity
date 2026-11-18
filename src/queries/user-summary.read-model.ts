import { Role } from '../domain/role.enum';
import { User } from '../domain/user.aggregate';
import { UserStatus } from '../domain/user-status.enum';

/**
 * One user as shown to admins by `GET /users` and `GET /users/{id}`. A read model, neither the
 * aggregate nor the entity: it never carries the password hash or `updatedAt`.
 */
export interface UserSummaryReadModel {
  /** User id. */
  id: string;
  /** Customer id; `null` for users without one (admins). */
  customerId: string | null;
  /** Normalized email. */
  email: string;
  /** Display name. */
  name: string;
  /** Roles the user holds. */
  roles: Role[];
  /** Account status. */
  status: UserStatus;
  /** Creation time. */
  createdAt: Date;
  /** Time of the last successful login; `null` until the first one. */
  lastLoginAt: Date | null;
}

/** One page of users matching a `ListUsersQuery`. */
export interface UserPageReadModel {
  /** The users of the page, newest first (`createdAt` desc, then `id` desc). */
  items: UserSummaryReadModel[];
  /** Number of users matching the filters, ignoring paging. */
  total: number;
  /** Page size applied. */
  limit: number;
  /** Number of matching users skipped. */
  offset: number;
}

/**
 * Builds the admin read model from a `User` aggregate, with the same fields the repository reads
 * for `GET /users/{id}`. Used when a command returns the user it just changed.
 *
 * @param user The aggregate.
 */
export function toUserSummary(user: User): UserSummaryReadModel {
  return {
    id: user.id,
    customerId: user.customerId,
    email: user.email.value,
    name: user.name.value,
    roles: user.roles,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}
