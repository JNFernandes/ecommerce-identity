# 0005. Default-deny route guards with local access token verification

- **Status**: Accepted
- **Date**: 2026-11-18

## Context

US-05 adds the first protected endpoint (`GET /users/me`), and admin routes follow in US-06. Every
non-public endpoint must declare its roles (constitution, Principle III). A protected route that
someone forgets to annotate must not become public by accident.

The service signs its own access tokens (ADR 0001), so it holds every public key it trusts in the
`KeyRing`: the active key and the retired keys. Downstream services verify against JWKS. This
service can verify the same way, without any network call.

Access tokens live 15 minutes and are not revoked by logout (ADR 0002).

## Decision

We will verify access tokens locally with `jose` against the key ring. The verifier imports every
published key once at startup and looks it up by `kid`. It accepts RS256 only, and checks `iss`,
`aud`, `exp`, `nbf` and a future `iat` with a configurable clock tolerance
(`JWT_CLOCK_TOLERANCE_SECONDS`, default 5). The verifier sits behind the `AccessTokenVerifier` port.

We will register two global guards, in this order:

1. `JwtAuthGuard` authenticates and returns 401.
2. `RolesGuard` authorizes and returns 403.

Every route must carry exactly one of `@Public()` or a non-empty `@Roles(...)`. `RoutePolicyCheck`
enforces this at application bootstrap: it lists every violating route and stops startup.

Every authentication failure is one `InvalidAccessTokenError`. A single exception filter maps it to
a byte-identical 401 with `WWW-Authenticate: Bearer`. The reason is only logged.

We will not keep a `jti` blacklist. The short access token lifetime bounds the exposure after logout
or a disable. `GET /users/me` re-reads the user, so a disabled or deleted account is refused there.

Rejected alternatives:

- **Per-route `@UseGuards`**: forgetting the decorator on one route silently makes that route public.
- **A list of public paths in configuration**: the list drifts from the code as routes are added or
  renamed, and it is not visible next to the handler.
- **Fetching our own JWKS over HTTP**: it adds a network dependency and a failure mode for data the
  process already holds.

## Consequences

- A new route without a policy fails at startup and in tests, never in production traffic.
- `@Roles` also writes the Swagger security, `x-roles`, 401 and 403. The docs therefore match the
  enforcement.
- Verification costs one in-memory RS256 check per request and needs no database or network.
- A stolen access token stays usable until it expires, even after logout or a disable, except on
  routes that re-read the user. Handlers that need the current account state must read it.
- Every existing controller now carries `@Public()` at class level. Adding a protected handler to
  one of them requires a handler-level `@Roles`, and having both decorators is itself a violation.
  So such a handler belongs in a non-public controller.
