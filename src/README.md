# AppModule

Root module of `ecommerce-identity`.

**Responsibility:** wires configuration (`config/`), PostgreSQL through TypeORM
(`infra/database/`), the Kafka producer (`infra/kafka/`) and the HTTP layer. Layers follow
Controller → Service → Domain → Repository (Constitution Principle I).

**Endpoints:**

- `GET /health` — `HealthController` → `HealthService`. `200` when PostgreSQL answers, `503`
  otherwise; the Kafka producer state is reported but never fails the check.
- `GET /docs`, `GET /docs-json` — Swagger UI and OpenAPI document (`app.swagger.ts`).

**Domain events produced:** none yet. `identity.user-registered` arrives with the registration
story.

**Shared setup:** `app.setup.ts` (CORS from `CORS_ALLOWED_ORIGINS`, global `ValidationPipe` with
`whitelist` and `forbidNonWhitelisted`) is applied by `main.ts` and by the tests.
