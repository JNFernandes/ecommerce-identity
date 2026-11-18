/** Query for one user by id, for admins (`GET /users/{id}`). */
export class GetUserQuery {
  /** @param id The user id (a UUID, already validated). */
  constructor(readonly id: string) {}
}
