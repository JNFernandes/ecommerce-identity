# Research: Current user endpoint and role-based access guards (US-05)

No `NEEDS CLARIFICATION` remained after the clarification session. Each entry gives the decision first, then the reason.

## R1. Verifier behind a port
`AccessTokenVerifier` is an abstract class in `services/ports/`, implemented by `JoseAccessTokenVerifier` in `infra/auth/`. This mirrors `TokenIssuer` / `JoseTokenIssuer`, so guards and tests depend on the port, not on `jose`.

## R2. Keys come from the existing `KeyRing`
At startup the factory imports every `KeyRing.keys` JWK (active and retired) into a `Map<kid, KeyObject>` once. The `jwtVerify` key resolver looks up `header.kid` and throws if it is missing or unknown. The verifier trusts exactly what JWKS publishes and makes no network call or file read per request.

## R3. `jwtVerify` options
The options are `algorithms: ['RS256']`, `issuer`, `audience`, `clockTolerance` and `requiredClaims: ['sub', 'iat', 'exp', 'jti']`. The algorithm allowlist rejects `none` and `HS256`, including HMAC with the public key, before any key is used.

## R4. Future `iat` checked explicitly
jose checks `iat` only when `maxTokenAge` is set, so the verifier rejects `iat > now + tolerance` itself (spec edge case). `nbf` is already checked by jose with the same tolerance.

## R5. Claim shape validated in the domain
`AuthenticatedPrincipal.fromClaims` in `src/domain/` requires a non-empty `sub`, a non-empty `roles` list of known `Role` values, and a string `customerId` when one is present. Which claims make a valid principal is a business rule (Principle I). It throws `InvalidAccessTokenError`.

## R6. One typed error
`InvalidAccessTokenError` (`domain/errors/`) has a fixed message and a `reason` that is only logged. The verifier wraps every jose error, header problem and claim problem in it, and so does the `GET /users/me` handler for a missing or non-`ACTIVE` user.

## R7. Mapping in the controller layer
`AccessTokenExceptionFilter` (`@Catch(InvalidAccessTokenError)`, registered as `APP_FILTER`, in `controllers/auth/`) returns 401 with `WWW-Authenticate: Bearer` and the body `{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}`. A single mapping point makes every 401 byte-identical. `RolesGuard` throws `ForbiddenException('forbidden')`.

## R8. Guards: two `APP_GUARD`s, in registration order
`JwtAuthGuard` is registered before `RolesGuard`, and Nest runs global guards in registration order, so authentication always precedes roles (US3-AS3). Both guards skip `@Public` handlers or classes (`Reflector.getAllAndOverride`). The route-level `ThrottlerGuard` still runs after them on the public auth routes.

## R9. Bearer extraction
The header must match `/^Bearer ([^\s]+)$/i`: the scheme is case-insensitive, and an empty value, extra spaces or two tokens are rejected. Anything that does not match is `InvalidAccessTokenError(MALFORMED_HEADER)`. Public routes never read the header.

## R10. Principal on the request
`JwtAuthGuard` sets `request.principal: AuthenticatedPrincipal`, typed through an `AuthenticatedRequest` interface (no `any`). `@CurrentUser()` is a `createParamDecorator` that returns it, so handlers never parse tokens (FR-010).

## R11. `@Roles` also writes the Swagger docs
`@Roles(...roles)` applies the metadata plus `ApiBearerAuth()`, `ApiUnauthorizedResponse`, `ApiForbiddenResponse` and `ApiExtension('x-roles', roles)`. Docs therefore cannot drift from enforcement (FR-014). `addBearerAuth()` already exists in `app.swagger.ts`.

## R12. Startup route policy check
`RoutePolicyCheck implements OnApplicationBootstrap` walks controllers with `DiscoveryService` and `MetadataScanner`, and checks each handler that has a `PATH_METADATA`. It fails with one error listing every handler that has neither `@Public` nor `@Roles`, or that has both, or that has an empty `@Roles()`. `app.listen()` calls `init()` first, so no request is served before the check. The pure function `findRoutePolicyViolations(controllers, reflector)` is shared with the unit test.

## R13. Swagger UI is outside Nest routing
`/docs` and `/docs-json` are Express handlers mounted by `SwaggerModule`, so guards never run on them and they stay public with no annotation.

## R14. `GET /users/me` through the `QueryBus`
`UsersController` → `GetCurrentUserQuery(userId)` → `GetCurrentUserService` (`@QueryHandler`) → `UserRepository.findById` → `CurrentUserReadModel`. CQRS is already imported. Fresh reads satisfy "as stored now". An unavailable database propagates as 5xx, never as a 401.

## R15. Clock tolerance configuration
`jwt.clockToleranceSeconds` is parsed with `parseNonNegativeInteger(JWT_CLOCK_TOLERANCE_SECONDS, 5)`. An invalid value fails startup instead of silently using the default.

## R16. Admin in tests
The startup admin seed (ADR 0003) is not implemented yet. Component tests insert an `ADMIN` user through `UserRepository`, then log in normally. The seed itself is outside this story.

## R17. Test-only `ADMIN` route
`tests/component/support/admin-probe.controller.ts` (`@Roles(Role.ADMIN)`, `GET /test/admin-probe`) is added only to the test module. It is never shipped and is removed when US-06 adds real admin routes.

## R18. ADR
`docs/adr/0005-default-deny-route-guards.md` records local verification, default deny with the startup check, and no blacklist. Rejected alternatives: per-route `@UseGuards` (easy to forget) and a public path list (it drifts from the code).
