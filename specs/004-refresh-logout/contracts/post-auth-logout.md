# Contract: `POST /auth/logout` (public, refresh token required, rate limited)

## Request (`RefreshTokenDto`, JSON)

```json
{ "refreshToken": "q8Xv…" }
```

The body has the same validation as `POST /auth/refresh`. No access token is needed.

## Responses

| Status | When | Body |
|---|---|---|
| 204 | The body is well formed, whatever the token's state (unknown, expired, used, revoked or valid) | none |
| 400 | The body is invalid | Nest validation error body |
| 429 | More than `RATE_LIMIT_LOGOUT_LIMIT` requests from one IP within `RATE_LIMIT_LOGOUT_TTL_MS` | Throttler error body |
| 5xx | The database is unavailable | Nest error body; never a 204 |

## Side effects

- **Known token**: every unrevoked token of its family gets `revokedAt = now`, and `replacedBy` stays null.
- **Unknown token**: nothing changes.
- Access tokens that were already issued stay valid until their `exp`. The README documents this trade-off.
