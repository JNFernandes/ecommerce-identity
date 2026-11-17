# Contract: `POST /auth/register` (public, rate limited)

## Request (`RegisterDto`, JSON)

```json
{ "email": "Ana@Example.com ", "name": "Ana", "password": "correct-horse-battery" }
```

Exactly these three string fields. Any other property, such as `roles`, `status`, `id` or `customerId`, returns 400.

## Responses

| Status | When | Body |
|---|---|---|
| 201 | Account created | `RegisterResponseDto` (below) |
| 400 | Malformed JSON, missing or non-string field, unknown property, invalid email, password outside 10–128 or equal to the email, name empty or longer than 100 | Nest error body (`statusCode`, `message`, `error`) |
| 409 | Email already registered (case-insensitive) | `{ "statusCode": 409, "message": "email already registered", "error": "Conflict" }` |
| 429 | More than `RATE_LIMIT_REGISTER_LIMIT` requests from one IP within `RATE_LIMIT_REGISTER_TTL_MS` | Throttler error body |

`RegisterResponseDto` (201). Exactly these fields, never a password, hash or token:

```json
{
  "id": "7d6f…-uuid",
  "customerId": "1b2c…-uuid",
  "email": "ana@example.com",
  "name": "Ana",
  "roles": ["CUSTOMER"],
  "createdAt": "2026-11-17T12:00:00.000Z"
}
```

Swagger: `@ApiTags('auth')`, `@ApiCreatedResponse`, `@ApiBadRequestResponse`, `@ApiConflictResponse`, `@ApiTooManyRequestsResponse`, and `@ApiProperty` on every DTO field.
