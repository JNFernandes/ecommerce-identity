import { AuthenticatedPrincipal } from '../../domain/authenticated-principal';

/** Port for verifying access tokens issued by this service. Used as the Nest injection token. */
export abstract class AccessTokenVerifier {
  /**
   * Verifies an access token locally (no network call) and builds its principal.
   *
   * @param token The compact JWS from the `Authorization` header. Never logged.
   * @returns The caller the token names.
   * @throws InvalidAccessTokenError For any token that is malformed, not signed by a published key,
   * issued for another issuer or audience, outside its lifetime, or missing required claims.
   */
  abstract verify(token: string): Promise<AuthenticatedPrincipal>;
}
