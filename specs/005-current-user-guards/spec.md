# Feature Specification: Current user endpoint and role-based access guards (US-05)

**Feature Branch**: `feature/US-05-current-user-guards`

**Created**: 2026-11-18

**Status**: Draft

**Input**: User description: "US-05: Current user endpoint and role-based access guards.
GET /users/me with a Bearer access token returns id, customerId (only if present), email, name,
roles, status and createdAt, read from the database; a missing or non-ACTIVE user gets 401. A global
authentication guard verifies access tokens locally against the service's own key set (active and
retired public keys), no network call: RS256 only (alg none, HS256 and HMAC-with-public-key
rejected), key chosen by kid, iss and aud checked, exp with JWT_CLOCK_TOLERANCE_SECONDS (default 5).
Verified claims (sub, customerId, roles) reach controllers through a CurrentUser decorator. Default
deny: routes need authentication unless @Public; @Roles(...) restricts to CUSTOMER/ADMIN; a route
with neither is a startup error. Existing endpoints (register, login, refresh, logout, JWKS, health,
Swagger UI) are public. Any token failure returns the same generic 401 with WWW-Authenticate:
Bearer; missing role returns 403. No tokens or Authorization headers in logs or error bodies.
Swagger declares the bearer scheme and per-route roles. Works without Kafka. Out of scope: admin
endpoints (US-06), token blacklist / jti revocation, introspection endpoint, API keys."

## Clarifications

### Session 2026-11-18

- Q: How are access tokens verified? → A: Locally, with the US-03 signing key set (active + retired); no network call.
- Q: Clock tolerance for `exp` (and `iat`/`nbf`)? → A: 5 seconds (`JWT_CLOCK_TOLERANCE_SECONDS`).
- Q: `GET /users/me` for a disabled or missing user? → A: Generic 401 for any non-`ACTIVE` or missing user.
- Q: How is default deny enforced and how are public routes declared? → A: Checked at startup (undeclared route fails boot); public routes are exactly those marked with the public decorator, no path-based exclusion list.
- Q: Is there a token blacklist / `jti` revocation? → A: No; tokens stay valid until `exp`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See my own account (Priority: P1)

A logged-in customer or admin sends their access token and gets their current account details as
stored now, not as they were when the token was issued.

**Why this priority**: It is the first protected endpoint and the reference client of the guards;
client apps need it to show who is logged in.

**Independent Test**: Register and log in, call `GET /users/me` with the access token, and compare
the response with the stored user; repeat for the seeded admin.

**Acceptance Scenarios**:

1. **Given** an active customer with a valid access token, **When** they call `GET /users/me`,
   **Then** the response is 200 with exactly `id`, `customerId`, `email`, `name`, `roles`,
   `status` and `createdAt`, matching the stored user.
2. **Given** the active seeded admin with a valid access token, **When** they call
   `GET /users/me`, **Then** the response is 200 and has no `customerId` field.
3. **Given** a valid token whose user has since been disabled or deleted, **When** it is used on
   `GET /users/me`, **Then** the response is the generic 401.
4. **Given** any successful response, **When** it is inspected, **Then** it never contains a
   password, password hash or token.

---

### User Story 2 - Reject requests without a trustworthy token (Priority: P1)

Every protected route accepts only access tokens this service signed, still valid, for this
issuer and audience. Every other request gets the same answer, revealing nothing about why.

**Why this priority**: Security First is non-negotiable; a forged or downgraded token accepted once
compromises every account.

**Independent Test**: Call `GET /users/me` with no header, a non-Bearer header, a malformed token,
an expired token, a token with the wrong issuer or audience, an unknown `kid`, a tampered payload,
an `alg: none` token, and an HS256 token signed with the public key; compare the responses.

**Acceptance Scenarios**:

1. **Given** a missing `Authorization` header, a scheme other than `Bearer`, or a value that is not
   a well-formed token, **When** a protected route is called, **Then** the response is 401 with
   `WWW-Authenticate: Bearer` and the generic body.
2. **Given** a token with `alg` `none`, `HS256` (including one HMAC-signed with the service's public
   key) or any algorithm other than `RS256`, **When** it is presented, **Then** the response is the
   same 401.
3. **Given** a token with an unknown `kid`, a bad signature, a wrong `iss` or `aud`, or an `exp`
   more than the clock tolerance in the past, **When** it is presented, **Then** the response is
   the same 401.
4. **Given** all the 401 cases above, **When** their responses are compared, **Then** status,
   `WWW-Authenticate` header and body are identical, and none of them echoes the token.
5. **Given** a token signed with a key that has been retired but is still published, **When** it is
   presented before it expires, **Then** it is accepted.
6. **Given** a token whose `exp` passed less than the clock tolerance ago (default 5 seconds),
   **When** it is presented, **Then** it is accepted.

---

### User Story 3 - Restrict routes by role (Priority: P1)

Each protected route lists the roles allowed to call it. A valid token without one of those roles
is refused with 403, so later stories (US-06 admin endpoints) only declare roles.

**Why this priority**: The constitution requires every non-public endpoint to declare its roles;
the next story depends on it.

**Independent Test**: Using a test-only route restricted to `ADMIN`, call it with a customer token
(403) and an admin token (200); call `GET /users/me` with both (200).

**Acceptance Scenarios**:

1. **Given** a route restricted to `ADMIN`, **When** a valid customer token is presented, **Then**
   the response is 403 with a generic body.
2. **Given** a route restricted to `ADMIN`, **When** a valid admin token is presented, **Then** the
   request reaches the handler.
3. **Given** a route restricted to some roles, **When** no or an invalid token is presented,
   **Then** the response is 401 (authentication is checked before roles).
4. **Given** a handler on a protected route, **When** it runs, **Then** it receives the verified
   `sub`, `roles` and (customers only) `customerId` without reading the token itself.

---

### User Story 4 - Default deny for every route (Priority: P2)

A developer cannot forget to protect a route: every route is protected unless explicitly marked
public, and a route that is neither public nor role-restricted stops the service at startup.

**Why this priority**: Turns the constitutional rule "an endpoint without a declaration is a
violation" into something the service enforces.

**Independent Test**: Start the application and check that it starts; start a test module with a
route that has no declaration and check that startup fails naming the route; call every existing
public endpoint without a token.

**Acceptance Scenarios**:

1. **Given** the service's routes, **When** it starts, **Then** startup succeeds only if every
   route is either public or declares roles; otherwise it fails with a message naming the route.
2. **Given** no token, **When** register, login, refresh, logout, JWKS, health or the API
   documentation is called, **Then** each behaves exactly as before this story.
3. **Given** a route marked public, **When** an invalid token is also sent, **Then** the route still
   works (public routes ignore the header).

---

### User Story 5 - Discover authentication in the API documentation (Priority: P3)

Client developers see in the API documentation which routes need a bearer token and which roles
they require, and can try protected routes with a token.

**Why this priority**: Developer experience; the security works without it.

**Independent Test**: Open the API documentation and check the bearer scheme and the per-route
security and roles.

**Acceptance Scenarios**:

1. **Given** the API documentation, **When** it is opened, **Then** it declares a bearer token
   scheme, `GET /users/me` requires it and lists `CUSTOMER`, `ADMIN` with 401 and 403 responses,
   and public routes require no token.

### Edge Cases

- `Authorization: Bearer` with an empty value, extra spaces or two tokens: generic 401.
- Lower-case `bearer` scheme: accepted (the scheme name is case-insensitive).
- A token with no `kid`, or a `kid` that belongs to no published key: generic 401.
- A token whose `roles` claim is missing, empty, not a list or holds an unknown role: generic 401.
- A token missing `sub`, `iat`, `exp` or `jti`, or with `nbf`/`iat` far in the future beyond the
  tolerance: generic 401.
- A refresh token (opaque) sent as a Bearer token: generic 401.
- A customer whose roles changed after the token was issued: the token's roles decide access until
  it expires; `GET /users/me` shows the stored roles.
- Database unavailable during `GET /users/me`: 5xx, never a 401 that hides the outage. Token
  verification itself needs no database or network.
- Kafka unreachable: no effect (this story publishes no events).
- Tokens and `Authorization` headers never appear in logs or error bodies, also for 401 and 403.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose `GET /users/me`, restricted to `CUSTOMER` and `ADMIN`,
  returning exactly `id`, `customerId` (omitted when the user has none), `email`, `name`, `roles`,
  `status` and `createdAt`, read from the stored user identified by the token's `sub`.
- **FR-002**: `GET /users/me` MUST return the generic 401 when the user no longer exists or its
  status is not `ACTIVE`.
- **FR-003**: Every route MUST require a verified access token unless it is explicitly marked
  public on the route itself (default deny). There is no path-based or global exclusion list.
- **FR-004**: Access tokens MUST be verified locally against the signing key set from US-03 (the
  same active and retired public keys the JWKS endpoint publishes), with no network call, choosing
  the key by the header `kid`.
- **FR-005**: Only `RS256` MUST be accepted; `none`, `HS256` (including HMAC with the public key)
  and every other algorithm MUST be rejected.
- **FR-006**: `iss` and `aud` MUST match configuration; `exp` MUST be checked with a clock
  tolerance from `JWT_CLOCK_TOLERANCE_SECONDS` (default 5, listed in `.env.example`).
- **FR-007**: The token MUST carry `sub`, `roles` (non-empty list of known roles), `iat`, `exp`
  and `jti`; `customerId`, when present, MUST be a string. Otherwise it is rejected.
- **FR-008**: Every authentication failure MUST return 401 with `WWW-Authenticate: Bearer` and one
  identical generic body, whatever the cause.
- **FR-009**: A route MAY declare allowed roles (`CUSTOMER`, `ADMIN`); a verified token holding
  none of them MUST receive 403 with a generic body. Authentication is checked before roles.
- **FR-010**: Verified `sub`, `roles` and `customerId` MUST be provided to route handlers by the
  framework; handlers MUST NOT parse tokens or the `Authorization` header.
- **FR-011**: A route that is neither public nor role-restricted MUST make startup fail, before
  any request is served, with a message naming the route.
- **FR-012**: Register, login, refresh, logout, JWKS, health and the API documentation MUST be
  public and behave as before.
- **FR-013**: Tokens and `Authorization` headers MUST NOT appear in logs or error bodies; the
  failure reason may be logged without the token.
- **FR-014**: The API documentation MUST declare the bearer scheme and, per protected route, the
  required roles and the 401/403 responses.
- **FR-015**: The service MUST start and serve all routes of this story when Kafka is unreachable.

### Key Entities

- **Authenticated principal**: the verified identity of a request: user id (`sub`), roles, and
  `customerId` for customers. Derived only from a verified token, never from client input.
- **User** (existing): `GET /users/me` reads its current id, customerId, email, name, roles,
  status and creation time.
- **Signing key set** (existing from US-03): active and retired public keys with their `kid`;
  the verifier uses the same set the JWKS endpoint publishes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An active user with a valid token gets their account details in a single request,
  answered in under 1 second under normal load.
- **SC-002**: 100% of forged, downgraded (`none`, `HS256`), expired, wrong-issuer, wrong-audience
  or unknown-key tokens are rejected, with byte-identical 401 responses.
- **SC-003**: 100% of routes are either public or role-restricted; a route with neither prevents
  the service from starting.
- **SC-004**: 100% of role mismatches return 403 and never reach the handler.
- **SC-005**: Token verification makes 0 network calls.
- **SC-006**: 0 occurrences of a token or `Authorization` header in any log line or error body
  across the test suite.
- **SC-007**: With messaging unavailable, 100% of valid `GET /users/me` requests still succeed.

## Assumptions

- The verifier trusts exactly the keys the JWKS endpoint publishes (active + retired, US-03); a key
  removed from the set invalidates its tokens.
- The clock tolerance also applies to `iat`/`nbf` checks; no `nbf` claim is issued today.
- The generic 401 body has the same shape as other errors with a neutral message (e.g.
  "unauthorized"); the 403 body uses a neutral message (e.g. "forbidden").
- `GET /users/me` returning 401 for a disabled or missing user uses the same generic 401, so it
  does not reveal account state.
- Role checks use the token's `roles`; current roles are re-read only by `GET /users/me`, login and
  refresh (constitution: changes apply when tokens expire).
- A test-only role-restricted route (not shipped) is used to exercise the 403 path until US-06.
- Out of scope: admin endpoints (US-06), token blacklist or revocation by `jti` (an access token
  stays valid until `exp`; disabling a user takes effect on `GET /users/me`, refresh and login),
  an introspection endpoint, API keys.
