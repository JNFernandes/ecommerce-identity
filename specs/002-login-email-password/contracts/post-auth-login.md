# Contract: `POST /auth/login` (public, rate limited)

## Request (`LoginDto`, JSON)

```json
{ "email": " Ana@Example.com ", "password": "correct-horse-battery" }
```

The body has exactly two string fields, both `@IsString` and `@IsNotEmpty`. The password is not trimmed. Any other property, a missing field, a non-string value or malformed JSON returns 400.

## Responses

| Status | When | Body |
|---|---|---|
| 200 | Credentials valid and user `ACTIVE` | `LoginResponseDto` (below) |
| 400 | Body invalid (see above) or email badly formed | Nest error body |
| 401 | Unknown email, wrong password, or user not `ACTIVE` | **always** `{ "statusCode": 401, "message": "invalid credentials", "error": "Unauthorized" }` |
| 429 | More than `RATE_LIMIT_LOGIN_LIMIT` requests from one IP, or for one normalized email, within `RATE_LIMIT_LOGIN_TTL_MS` | Throttler error body |
| 5xx | Database unavailable | Nest error body; never 401, no token |

`LoginResponseDto` (200). It has exactly these fields:

```json
{
  "accessToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6…",
  "refreshToken": "q8Xv…43 base64url chars",
  "tokenType": "Bearer",
  "expiresIn": 900
}
```

The refresh token appears only in this response and cannot be recovered later. The access token format is in [access-token.md](access-token.md).

Swagger: `@ApiTags('auth')`, `@ApiOkResponse`, `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`, `@ApiTooManyRequestsResponse`, and `@ApiProperty` on every DTO field.
