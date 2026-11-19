import { SkipThrottle, ThrottlerGetTrackerFunction } from '@nestjs/throttler';
import { Email } from '../domain/email.value-object';

/** Name of the throttler that limits `POST /auth/register` per client IP. */
export const REGISTER_THROTTLER = 'register';

/** Name of the throttler that limits `POST /auth/login` per client IP. */
export const LOGIN_IP_THROTTLER = 'login-ip';

/** Name of the throttler that limits `POST /auth/login` per normalized email. */
export const LOGIN_EMAIL_THROTTLER = 'login-email';

/** Name of the throttler that limits `POST /auth/refresh` per client IP. */
export const REFRESH_THROTTLER = 'refresh';

/** Name of the throttler that limits `POST /auth/logout` per client IP. */
export const LOGOUT_THROTTLER = 'logout';

/** Name of the throttler that limits `POST /users/me/password` per user id and client IP. */
export const PASSWORD_CHANGE_THROTTLER = 'password-change';

/** Every named throttler registered by the app. */
export const ALL_THROTTLERS = [
  REGISTER_THROTTLER,
  LOGIN_IP_THROTTLER,
  LOGIN_EMAIL_THROTTLER,
  REFRESH_THROTTLER,
  LOGOUT_THROTTLER,
  PASSWORD_CHANGE_THROTTLER,
] as const;

/**
 * Skips every named throttler except the given ones, so each route only counts against its own
 * buckets. With no argument, skips them all.
 *
 * @param own The throttlers that apply to the route.
 */
export function onlyThrottlers(...own: string[]): MethodDecorator & ClassDecorator {
  return SkipThrottle(
    Object.fromEntries(
      ALL_THROTTLERS.filter((name) => !own.includes(name)).map((name) => [name, true]),
    ),
  );
}

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

/**
 * Builds the tracker of the password change throttler: `user:<id>|ip:<ip>`, so one user cannot
 * be blocked by another user on the same address, and one stolen token used from many addresses
 * still gets a bucket per address. The user id comes from the principal `JwtAuthGuard` attached
 * (global guards run before route guards); without one, it falls back to `ip:<ip>`.
 */
export function passwordChangeThrottleTracker(): ThrottlerGetTrackerFunction {
  return (req: Record<string, unknown>): string => {
    const ip = clientIp(req);
    const principal = req.principal;
    const userId =
      typeof principal === 'object' && principal !== null
        ? (principal as Record<string, unknown>).userId
        : undefined;
    return typeof userId === 'string' ? `user:${userId}|ip:${ip}` : `ip:${ip}`;
  };
}
