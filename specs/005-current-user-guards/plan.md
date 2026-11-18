# Implementation Plan: Current user endpoint and role-based access guards (US-05)

**Branch**: `feature/US-05-current-user-guards` | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-current-user-guards/spec.md`

## Summary

Every route is denied by default. Two global guards run in order:

1. `JwtAuthGuard` skips `@Public` routes. On other routes it extracts the Bearer token and passes it to the `AccessTokenVerifier` port. The port's implementation, `JoseAccessTokenVerifier` (`jwtVerify` with RS256 only, a `kid` resolver over the existing `KeyRing`, and `iss`/`aud`/clock tolerance from configuration), returns an `AuthenticatedPrincipal` built in the domain. The guard attaches that principal to the request.
2. `RolesGuard` enforces `@Roles`.

`@CurrentUser()` hands the principal to handlers.

Every authentication failure is a single `InvalidAccessTokenError`. A controller-layer exception filter maps it to an identical 401 with `WWW-Authenticate: Bearer`. A role mismatch returns 403.

`RoutePolicyCheck` (`OnApplicationBootstrap`) fails startup and lists every route that has neither `@Public` nor `@Roles`.

`GET /users/me` goes from `UsersController` to `GetCurrentUserQuery`, `GetCurrentUserService` (`@QueryHandler`), `UserRepository.findById`, and then the read model and DTO. A missing or non-`ACTIVE` user gets the same 401.

No new package and no migration are needed. Decisions are in [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 20

**Primary Dependencies**: NestJS 10 (`APP_GUARD`, `APP_FILTER`, `DiscoveryModule`), `@nestjs/cqrs` (`QueryBus`), `jose` 5 (`jwtVerify`, `importJWK`), `@nestjs/swagger`. No new packages.

**Storage**: PostgreSQL, read only (`users`). There is no schema change.

**Testing**: Jest, Supertest, testcontainers (PostgreSQL; Kafka on a closed port)

**Target Platform**: Linux container / local Node

**Project Type**: web service (REST microservice)

**Performance Goals**: `GET /users/me` answers in under 1 s (SC-001). Verification is one in-memory RS256 check, and the request makes one indexed read by primary key.

**Constraints**:
- Verification makes no network call.
- Every 401 is byte-identical.
- No token or `Authorization` value appears in logs or error bodies.
- Startup fails on an undeclared route.

**Scale/Scope**:
- 1 endpoint
- 2 guards, 1 filter, 3 decorators
- 1 startup check, 1 verifier, 1 value object, 1 error type

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I. DDD layering | ✅ | **Controller layer** (guards, filter, decorators, `UsersController`): HTTP I/O and the error mapping. **Service** (`GetCurrentUserService`): orchestration only. **Domain** (`AuthenticatedPrincipal`, `InvalidAccessTokenError`, `User.canLogin`): the claim and status rules. **Infra** (`JoseAccessTokenVerifier`): cryptography behind a port. |
| II. Security | ✅ | Only RS256 is accepted; `none` and `HS256` are rejected. The key is chosen by `kid` from the published set. `iss`, `aud`, `exp` and `iat` are checked with a 5 s tolerance. There is one generic 401. No token is logged (tested). The JWKS set gains no private material. |
| III. Authorization | ✅ | Every route is `@Public` or declares roles, and startup enforces this. `GET /users/me` is restricted to `CUSTOMER` and `ADMIN`, as listed in the constitution's table. No role-changing endpoint is added. `customerId` comes only from the verified token. |
| IV. Write flow | ✅ | Nothing is written or published. |
| V. Types and validation | ✅ | The claims are parsed from `unknown` into a typed principal, and `AuthenticatedRequest` is typed. There is no `any`. Domain errors are mapped in the controller layer. |
| VI/VII. Tests | ✅ | Unit, policy and component tests are listed below. The component tests use real PostgreSQL. |
| VIII. Kafka | ✅ | Nothing is published. A test confirms `GET /users/me` works with Kafka unreachable. |
| IX. Branching | ✅ | Work is on `feature/US-05-current-user-guards`. |
| X. Quality gate | ✅ | The gate runs after every task. |

Post-design re-check: there are no violations and no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/005-current-user-guards/
├── plan.md  research.md  data-model.md  quickstart.md
└── contracts/  get-users-me.md  access-control.md
```

### Source Code (new or changed)

```text
src/
├── domain/authenticated-principal.ts            # fromClaims, hasAnyRole (R5)
├── domain/errors/invalid-access-token.error.ts  # + AccessTokenFailureReason (R6)
├── services/ports/access-token-verifier.ts      # verify(token): Promise<AuthenticatedPrincipal> (R1)
├── infra/auth/jose-access-token-verifier.ts     # jwtVerify, kid map from KeyRing, iat check (R2–R4)
├── controllers/auth/
│   ├── public.decorator.ts, roles.decorator.ts (+ Swagger, R11), current-user.decorator.ts
│   ├── jwt-auth.guard.ts, roles.guard.ts         # APP_GUARD x2, in this order (R8, R9)
│   ├── access-token-exception.filter.ts          # 401 + WWW-Authenticate (R7)
│   ├── authenticated-request.ts
│   └── route-policy.check.ts                     # findRoutePolicyViolations + OnApplicationBootstrap (R12)
├── controllers/users.controller.ts              # GET /users/me
├── controllers/auth.controller.ts, jwks.controller.ts, health.controller.ts   # + @Public
├── queries/get-current-user.query.ts
├── services/get-current-user.service.ts         # @QueryHandler, CurrentUserReadModel (R14)
├── dto/current-user-response.dto.ts
├── config/configuration.ts                      # + jwt.clockToleranceSeconds (R15)
├── app.module.ts                                # + DiscoveryModule, verifier factory, guards, filter, check, handler
└── README.md                                    # module README: endpoint and guards
docs/adr/0005-default-deny-route-guards.md (+ index)   # R18
README.md (calling with a token, access control model, default deny, env table), .env.example
```

**Structure Decision**: The single-project layout from earlier stories stays. The HTTP auth pieces live in `controllers/auth/` because they are controller-layer code. Verification sits behind a port, like `TokenIssuer`.

### Tests

**Unit**

- `JoseAccessTokenVerifier` (keys generated in the test, real `jose` signing):
  - a valid token becomes a principal;
  - expired beyond the tolerance is rejected;
  - expired within the tolerance is accepted;
  - a wrong signature (tampered payload) is rejected;
  - `alg: none` is rejected;
  - HS256 signed with the public key as the secret is rejected;
  - a wrong issuer and a wrong audience are rejected;
  - a missing `kid` and an unknown `kid` are rejected;
  - a token signed by a retired key is accepted;
  - a future `iat` beyond the tolerance is rejected;
  - a missing `jti` is rejected;
  - every failure is an `InvalidAccessTokenError`, and its message never contains the token.
- `AuthenticatedPrincipal.fromClaims` rejects empty, unknown, non-array and duplicate roles, a missing `sub`, and a non-string `customerId`. It accepts an admin with no `customerId`.
- `JwtAuthGuard`:
  - a `@Public` route skips the verifier, even when an invalid header is sent;
  - each header form is rejected (missing, `Basic`, empty, extra spaces, two tokens);
  - the lower-case scheme is accepted;
  - the principal is attached to the request.
- `RolesGuard`: public routes pass; a matching role passes; a mismatch throws a 403 with `forbidden`.
- `AccessTokenExceptionFilter` returns the exact status, header and body.
- `GetCurrentUserService` returns the read model. A missing user, and a `DISABLED` user, each give `InvalidAccessTokenError(USER_UNAVAILABLE)`.
- `CurrentUserResponseDto` leaves out `customerId` when it is null.
- Configuration: the tolerance defaults to 5, and an invalid value throws.

**Route policy**

- `findRoutePolicyViolations` returns an empty list for every controller registered in `AppModule`.
- It names a handler that has no decorator, one that has both decorators, and one with an empty `@Roles()`.
- Building a test module with an undeclared controller makes `init()` reject with the route in the message.

**Component**

- `/users/me` with a valid customer token returns 200 with exactly the contract fields and no password field. For an admin (a row inserted for the test, R16), the response has no `customerId`.
- `/users/me` with no token, and with a tampered token, returns 401 with `WWW-Authenticate: Bearer`, and the two bodies are identical.
- 401 after the user is disabled, and 401 after the user is deleted.
- The test-only `ADMIN` route (R17) returns 403 for a customer and 200 for an admin.
- Register, login, refresh, logout, JWKS, health and `/docs` work without a token, and also with an invalid one.
- With Kafka unreachable, `/users/me` still returns 200.
- The captured logs contain no access token and no `Authorization` value across all of the above.

### Docs to update

- **README**:
  - how to call protected routes (`Authorization: Bearer`);
  - the access control model (the route table and the 401 and 403 semantics);
  - the default-deny rule (`@Public` or `@Roles` is required, and startup fails otherwise);
  - add `JWT_CLOCK_TOLERANCE_SECONDS` to the environment table;
  - add "Roles (planned)" → current.
- **`src/README.md`**: the module README.
- **`.env.example`**
- **ADR 0005**

## Complexity Tracking

None.
