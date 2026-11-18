# Architecture Decision Records

Architectural decisions for `ecommerce-identity` are recorded here, as the project constitution
requires (Documentation Standards).

## Conventions

- One decision per file, named `NNNN-short-title.md` with a four-digit sequential number
  (`0001-...`, `0002-...`).
- Numbers are never reused or renumbered. To reverse a decision, write a new ADR and set the old
  one's status to `Superseded by NNNN`.
- Start from [`template.md`](template.md) (Context / Decision / Consequences).
- Add every new ADR to the index below in the same PR.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-rs256-access-tokens-with-jwks.md) | RS256 access tokens with a JWKS endpoint instead of a shared HS256 secret | Accepted |
| [0002](0002-refresh-token-rotation-with-reuse-detection.md) | Refresh token rotation with reuse detection (opaque tokens stored hashed) | Accepted |
| [0003](0003-admin-seed-and-no-role-change.md) | Admins only from a startup seed; no role-change endpoint | Accepted |
| [0004](0004-user-registered-event-choreography.md) | Registration publishes `identity.user-registered`; Orders creates the customer | Accepted |
| [0005](0005-default-deny-route-guards.md) | Default-deny route guards with local access token verification | Accepted |
