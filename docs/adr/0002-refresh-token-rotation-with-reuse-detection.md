# 0002. Refresh token rotation with reuse detection (opaque tokens stored hashed)

- **Status**: Accepted
- **Date**: 2026-11-17

## Context

Access tokens live 15 minutes (ADR 0001), so clients need a long-lived credential to obtain new
ones without asking for the password again. That credential is the most valuable secret a client
holds: whoever steals it can keep a session alive. We need to limit how long a stolen refresh
token is useful, detect theft, and be able to end sessions (logout, disabled users).

A self-contained JWT refresh token cannot be revoked without server state, and storing tokens in
clear would turn a database leak into a session takeover.

## Decision

We will use **opaque refresh tokens with rotation and reuse detection**:

- A refresh token is a random value with **at least 256 bits of entropy**. Only its hash is
  stored (`RefreshToken.tokenHash`); the clear value is returned to the client once.
- Each token belongs to a **family** (`familyId`) started at login. Every refresh revokes the
  presented token (`revokedAt`), links it to its successor (`replacedBy`) and issues a new token in
  the same family. Rotation is atomic: two concurrent refreshes with the same token cannot both
  succeed.
- Presenting a token that was **already used** means it was copied: the whole family is revoked
  and the request fails. Both the attacker and the legitimate client must log in again.
- Refresh checks the user's current status and roles, so a disabled user cannot refresh.
- Logout revokes the session's tokens. Lifetime is configurable.

## Consequences

- A stolen refresh token works at most until the legitimate client next refreshes, and its use is
  detected and shuts the session down.
- A database leak exposes only hashes, which cannot be presented as tokens.
- Identity keeps per-session state (one row per issued refresh token) and must clean up expired
  rows eventually.
- A client that retries a refresh after a lost response presents an already-used token and loses
  its session; clients must not blindly retry refresh requests.
- Follow-up: the refresh story adds the `refresh_tokens` table migration, the domain rules and the
  tests required by the constitution (rotation, reuse detection).

## Update (US-04, 2026-11-18)

Refresh and logout are implemented. The decision stands; these details were settled:

- **Absolute session limit.** A family ends at its login time + `JWT_SESSION_MAX_SECONDS` (default
  30 days). Each new refresh token expires at the earlier of now + `JWT_REFRESH_TTL_SECONDS` and
  that limit. The session start is derived as `MIN(createdAt)` of the family, so no column or
  migration was added, and a configuration change also applies to existing sessions.
- **Strict reuse detection, no grace window.** Any second use of a token revokes the family; the
  lost-response retry case is documented as a trade-off.
- **Family lock.** Every rotation, reuse revocation and logout takes a transaction-scoped
  PostgreSQL advisory lock on the family *before* any row lock (`findByHash` → `lockFamily` →
  `SELECT … FOR UPDATE`). This serializes all writers of one family, so a reuse racing the
  rotation of the newest token cannot leave a live token, and the fixed lock order rules out
  deadlocks.
- **Failures commit their revocations.** The refresh transaction returns a refusal instead of
  throwing, so a family revocation commits; one generic `401` is raised after the commit.
- **Logout revokes the family** and always answers `204` for a well-formed body.
- **Purge deferred.** Expired and revoked rows are kept; a purge job is future work.
