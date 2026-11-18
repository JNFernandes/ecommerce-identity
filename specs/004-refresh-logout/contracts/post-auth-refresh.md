# Contract: `POST /auth/refresh` (public, refresh token required, rate limited)

## Request (`RefreshTokenDto`, JSON)

```json
{ "refreshToken": "q8Xv…43 base64url chars" }
```

The body has exactly one field: a non-empty string of at most 512 characters. Any of the following returns 400, and no token is looked up:

- a missing field or a non-string value;
- malformed JSON;
- an unknown property.

## Responses

| Status | When | Body |
|---|---|---|
| 200 | The token is known, unused, unrevoked and unexpired; the user is `ACTIVE`; the session is within `JWT_SESSION_MAX_SECONDS` | `LoginResponseDto`: exactly `accessToken`, `refreshToken`, `tokenType: "Bearer"`, `expiresIn` |
| 400 | The body is invalid (see above) | Nest validation error body |
| 401 | The token is unknown, expired or reused/revoked, the user is not `ACTIVE`, or the session limit has passed | **always** `{ "statusCode": 401, "message": "invalid refresh token", "error": "Unauthorized" }` |
| 429 | More than `RATE_LIMIT_REFRESH_LIMIT` requests from one IP within `RATE_LIMIT_REFRESH_TTL_MS` | Throttler error body |
| 5xx | The database is unavailable | Nest error body; never a 401, no token issued |

## Side effects

- **200**: in one transaction, the presented token gets `revokedAt = now` and `replacedBy = new id`, and a new hashed token is stored in the same family. The new token expires at `min(now + JWT_REFRESH_TTL_SECONDS, familyStart + JWT_SESSION_MAX_SECONDS)`.
- **401 when the token was reused or revoked, or the user is not `ACTIVE`**: every unrevoked token of the family is revoked.
- **401 when the token is unknown or expired and unused**: nothing changes.

## Access token

The access token has the same claims as at login (see `specs/002-login-email-password/contracts/access-token.md`). It gets a new `jti`, and `roles` and `customerId` are read from the user's current record.
