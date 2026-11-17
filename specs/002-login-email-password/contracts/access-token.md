# Contract: access token (JWT, RS256)

Consumed by Orders, Payments, Inventory and Notifications (ADR 0001). The JWKS endpoint arrives in US-03. Until then, verifiers can use `keys/public.pem`.

## Header
```json
{ "alg": "RS256", "kid": "<RFC 7638 SHA-256 thumbprint of the public JWK>", "typ": "JWT" }
```

## Claims (exactly these)

| Claim | Value |
|---|---|
| `sub` | user id (UUID) |
| `customerId` | customer id (UUID). **Absent** when the user has none (admins) |
| `roles` | current roles, e.g. `["CUSTOMER"]` |
| `iss` | `JWT_ISSUER` |
| `aud` | `JWT_AUDIENCE` |
| `iat` | issue time (seconds) |
| `exp` | `iat + JWT_ACCESS_TTL_SECONDS` (default 900) |
| `jti` | unique UUID per token |

Verifiers MUST check the signature, `iss`, `aud` and `exp`, and MUST take `customerId` only from the verified token (constitution III).
