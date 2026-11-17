import { ThrottlerGetTrackerFunction } from '@nestjs/throttler';
import { Email } from '../domain/email.value-object';

/** Name of the throttler that limits `POST /auth/login` per client IP. */
export const LOGIN_IP_THROTTLER = 'login-ip';

/** Name of the throttler that limits `POST /auth/login` per normalized email. */
export const LOGIN_EMAIL_THROTTLER = 'login-email';

/** What a login throttle bucket is keyed on. */
export type LoginThrottleKind = 'ip' | 'email';

/** The client IP of a request, or `unknown`. */
function clientIp(req: Record<string, unknown>): string {
  return typeof req.ip === 'string' ? req.ip : 'unknown';
}

/**
 * Builds the tracker of a login throttler.
 *
 * - `ip`: the client IP (`req.ip`).
 * - `email`: the normalized body email (`Email.normalize`, as at registration), so casing,
 *   surrounding spaces and the client IP do not create new buckets. When the body has no string
 *   `email`, it falls back to `ip:<ip>` so invalid bodies do not share one global bucket.
 *
 * @param kind What the bucket is keyed on.
 */
export function loginThrottleTracker(kind: LoginThrottleKind): ThrottlerGetTrackerFunction {
  return (req: Record<string, unknown>): string => {
    const ip = clientIp(req);
    if (kind === 'ip') {
      return ip;
    }
    const body = req.body;
    const email =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).email
        : undefined;
    return typeof email === 'string' ? `email:${Email.normalize(email)}` : `ip:${ip}`;
  };
}
