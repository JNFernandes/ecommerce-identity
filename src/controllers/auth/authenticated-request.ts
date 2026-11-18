import { Request } from 'express';
import { AuthenticatedPrincipal } from '../../domain/authenticated-principal';

/** An Express request that passed `JwtAuthGuard` on a protected route. */
export interface AuthenticatedRequest extends Request {
  /** The caller, built from the verified access token. */
  principal: AuthenticatedPrincipal;
}
