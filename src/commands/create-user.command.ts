import { Role } from '../domain/role.enum';

/** Command to create a user with one role on behalf of an admin (`POST /users`). */
export class CreateUserCommand {
  /**
   * @param actingAdminId The id of the admin making the request (the access token's `sub`).
   * @param email The raw email; the domain validates and normalizes it.
   * @param name The raw name; the domain validates and trims it.
   * @param password The initial plain password chosen by the admin; never logged or stored.
   * @param roles The requested roles (exactly one, checked by the domain).
   */
  constructor(
    readonly actingAdminId: string,
    readonly email: string,
    readonly name: string,
    readonly password: string,
    readonly roles: readonly Role[],
  ) {}
}
