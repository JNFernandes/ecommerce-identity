# Research: Log in with email and password (US-02)

No `NEEDS CLARIFICATION` remained after the spec's clarification session. Each entry gives the decision and then the reason.

## R1. Same layout and CQRS shape as US-01
`LoginCommand` (`src/commands/`) is dispatched by `AuthController` through `CommandBus`, and `LoginService` (`src/services/`) is its `@CommandHandler`. The repo then reads the same way for both stories (US-01 R1/R2).

## R2. Domain owns the login rules
`User.canLogin()` returns true only when `status === ACTIVE`. `User.recordLogin(at)` sets `lastLoginAt` and throws `InvalidCredentialsError` when `!canLogin()`. `updatedAt` is left unchanged, because a login is not a change to the account. `RefreshToken.issue(...)` builds new `id`/`familyId` UUIDs and sets `expiresAt = issuedAt + ttl`. Principle I: the service only orchestrates.

## R3. `RefreshToken.issue({ userId, tokenHash, issuedAt, ttlSeconds })`
This extends the requested `issue(userId, ttl)` with the hash and the time. The domain stays I/O-free and deterministic: the hash comes from `RefreshTokenGenerator` and the time from `Clock`. The aggregate never sees the clear value.

## R4. Ports in `src/services/ports/`
- `PasswordHasher` gains `verify(plain, hash): Promise<boolean>` and `dummyHash(): string`.
- New ports: `TokenIssuer.issue(subject, issuedAt) → { token, expiresIn }`, `RefreshTokenGenerator.generate() → { value, hash }` (plus `hash(value)` for US-04), and `Clock.now()`.

All four are abstract classes used as DI tokens, as in US-01 R3. Unit tests replace them with plain mocks.

## R5. Exactly one verification per attempt
The handler normalizes the email with `Email.create` (an invalid format gives 400, as in US-01) and loads the user by `lower(email)`. It then always calls `verify(password, user?.passwordHash ?? hasher.dummyHash())`, and only after that checks `user`, the verify result and `canLogin()`. Each of those three failures throws `InvalidCredentialsError`. A disabled user and an unknown email therefore cost the same as a wrong password (FR-003/FR-004).

## R6. Dummy hash computed at startup
`Argon2PasswordHasher.onModuleInit` hashes a random 32-byte value once, with the configured parameters. The dummy verification then costs the same as a real one, and no fixed hash is committed. `argon2.verify` compares in constant time.

## R7. Single credential error
`InvalidCredentialsError` (`src/domain/errors/`) is the only error type for every credential failure. The controller maps it to `UnauthorizedException('invalid credentials')`, so the 401 body is byte-identical (SC-002). The reason (`unknown_email`, `wrong_password` or `inactive`) appears only in the handler's log line.

## R8. Signing key: file only, fail fast
`loadSigningKey(path)` (`src/infra/security/signing-key.ts`) reads the PEM file with `crypto.createPrivateKey`, which accepts PKCS#8 and PKCS#1. It requires an RSA key with a modulus of at least 2048 bits, derives the public JWK, and sets `kid = calculateJwkThumbprint(jwk, 'sha256')` (RFC 7638, stable across restarts). It is provided through an async factory provider (`SigningKey` token), so an error rejects `NestFactory.create` and `main.ts` exits with code 1. A `SigningKeyError` message names the problem (unset, not found, unreadable, not an RSA private key) and never includes file content. `JWT_ISSUER`/`JWT_AUDIENCE` get the same fail-fast check in the issuer factory.

## R9. `JoseTokenIssuer`
It uses `SignJWT` with the protected header `{ alg: 'RS256', kid, typ: 'JWT' }` and the claims `sub`, `roles`, and `customerId` only when non-null. It also sets `setIssuer`, `setAudience`, `setIssuedAt(iat)`, `setExpirationTime(iat + ttl)` and `setJti(randomUUID())`. `iat` comes from the injected time, which keeps tests deterministic. It returns `expiresIn = JWT_ACCESS_TTL_SECONDS`.

## R10. Refresh token value and hash
`CryptoRefreshTokenGenerator` takes `randomBytes(32)` (256 bits) as base64url, which gives 43 characters, and stores `sha256(value)` as 64 hex characters. A fast hash is enough because the input already has 256 bits of entropy, so a slow hash adds nothing. It is SHA-256 per FR-007.

## R11. One transaction for the refresh token and `lastLoginAt`
`RefreshTokenRepository.saveWithLogin(token, user)` uses `DataSource.transaction` to insert the token and update only `users."lastLoginAt"`. It is a single atomic write without a generic unit-of-work abstraction, which is not needed yet. A database error propagates as 5xx, never 401.

## R12. Throttling per IP and per email
There are two named throttlers, `login-ip` and `login-email`. Both use `RATE_LIMIT_LOGIN_LIMIT` (10) and `RATE_LIMIT_LOGIN_TTL_MS` (60000), and each has its own `getTracker` (throttler v6 per-throttler option):
- IP: `req.ip`.
- Email: `Email.normalize(body.email)` (trim and lowercase, extracted from `Email.create`, so it matches registration exactly). When `email` is not a string, it falls back to `ip:<ip>`, so invalid bodies do not share one global bucket.

`@SkipThrottle` keeps `register` off the login route and the login throttlers off the register route. The guard runs before pipes, so 400s count too, as the spec says all requests count. The same single tracker function serves both throttlers through a `kind` argument: one tracker module, two keys.

## R13. `npm run keys:generate`
`scripts/keys-generate.ts` (ts-node) writes `keys/private.pem` (PKCS#8, mode 0600) and `keys/public.pem` from a 2048-bit RSA pair. It refuses to overwrite unless `--force` is given, and prints the paths and `kid`, never the key. `scripts/` is added to the lint and format globs.

## R14. Test keys
The test-app helper generates an in-memory key pair, writes it to a temp file and sets `JWT_PRIVATE_KEY_PATH`, `JWT_ISSUER` and `JWT_AUDIENCE`. Existing US-01 component tests need these too, because startup now fails fast without them.

## R15. ADR
ADR 0001 is unchanged. The approach (RS256, key from a mounted file, `kid` in the header) is the same, and the RFC 7638 `kid` is an implementation detail. ADR 0002 is unchanged: the table arrives earlier (this story), but the design is the same.
