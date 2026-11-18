/** Query for the stored account of the caller of `GET /users/me`. */
export class GetCurrentUserQuery {
  /** @param userId The user id from the verified access token (`sub`). */
  constructor(readonly userId: string) {}
}
