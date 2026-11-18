# Contract: admin seed (startup)

The seed reads `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `ADMIN_NAME` (default `Administrator`) once, during `app.init()`, after migrations and before the server accepts requests.

| Situation | Outcome | Log |
|---|---|---|
| An admin exists (any status) | Nothing | none (debug at most) |
| No admin; `ADMIN_EMAIL` or `ADMIN_PASSWORD` is unset or empty | Nothing; the service starts | `warn`: no admin exists and `ADMIN_EMAIL` / `ADMIN_PASSWORD` are not set |
| No admin; a value breaks a registration rule | Nothing; the service starts | `error`: `ADMIN_<VAR>: <rule>` |
| No admin; `ADMIN_EMAIL` belongs to a non-admin user | Nothing; that user is unchanged; the service starts | `error`: `ADMIN_EMAIL` belongs to an existing non-admin user; seed skipped |
| No admin; values are valid and the email is free | Creates the user: `ADMIN`, `ACTIVE`, no `customerId`, argon2id hash | `log`: administrator seeded, with the user id |
| Another instance created the admin concurrently (unique email violation) | Nothing | `warn`: admin already seeded by another instance |
| Database error | Startup fails | Nest's startup error |

Invariants:

- The `ADMIN_PASSWORD` value never appears in a log line.
- The seed never modifies an existing user.
- The seed never publishes an event.
