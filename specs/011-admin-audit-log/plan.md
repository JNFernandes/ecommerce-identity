# Implementation Plan: Audit log of administrative actions (US-11)

**Branch**: `feature/US-11-admin-audit-log` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md)

## Summary

`GET /audit` (ADMIN) returns one filtered, newest-first page of `audit_records`. Most of the write
side already exists: the table and its append-only trigger (US-09, ADR 0009) and the
`USER_STATUS_CHANGED` retrofit (fix/US-07, commit 856e7a7, with unit/integration tests). This story
adds the read path, the filter indexes, the missing component-level checks and the docs.

## Technical Context

- **Stack**: TypeScript strict, NestJS 10 CQRS, TypeORM + PostgreSQL, Jest + testcontainers.
- **Storage**: existing `audit_records` (`occurredAt` timestamptz, `action` varchar). One new
  migration for indexes only. No new table, no Kafka.
- **Constraints**: no 500 on bad input; reads not logged or audited. No NEEDS CLARIFICATION.

## Constitution Check

| Principle | Status |
|-----------|--------|
| I Layering | PASS: controller (DTO) → query handler (re-check caller) → `AuditRecordRepository`. Read-only, so no domain logic beyond `AuditAction`. |
| II Security | PASS: response has no secrets/emails (records never store them); FR-002 re-read → generic 401. |
| V Validation | PASS: whitelist + `forbidNonWhitelisted`; `IsUUID`, `IsEnum`, `IsInt` reject repeated params (arrays) → 400. |
| VI/VII Tests | PASS: integration (repo paging/filters/indexes), component (endpoint, access, validation, status audit end-to-end). |
| XI Audit | PASS: `GET /audit` is the only reader; append-only trigger already in place; migration note on US-07 marked resolved. |

## Design decisions

- **Already done (verify, don't rebuild)**: trigger `audit_records_append_only` rejects
  UPDATE/DELETE for any role (chosen over GRANTs: works whatever user the app connects as);
  `ChangeUserStatusService` appends `AuditRecord.statusChanged` in the admin tx, no-op writes nothing.
- **Query**: `ListAuditRecordsQuery(actingAdminId, limit, offset, actorId?, targetId?, action?)` in
  `src/queries/`, plus `AuditRecordReadModel` / `AuditPageReadModel` (`createdAt` ← `occurredAt`).
- **Service**: `ListAuditRecordsService` re-reads the caller via `UserRepository.findById`; missing
  or not `isActiveAdmin()` → `InvalidAccessTokenError(USER_UNAVAILABLE)` (existing filter → 401).
- **Repository**: new `AuditRecordRepository.findPage(query)` (read-only, no update/delete methods):
  AND filters, `ORDER BY "occurredAt" DESC, id DESC`, `getManyAndCount`, mirrors `UserRepository.findPage`.
- **Indexes** (migration `AddAuditRecordIndexes`): `("occurredAt" DESC, id DESC)`,
  `("actorId", "occurredAt" DESC, id DESC)`, `("targetId", "occurredAt" DESC, id DESC)`; `action`
  has 3 values, so it uses the ordering index (no separate index).
- **API**: `AuditController` `@Controller('audit')`, `@Get()` `@Roles(Role.ADMIN)`;
  `ListAuditRecordsQueryDto` (reuse limit/offset bounds from `list-users-query.dto.ts`),
  `AuditRecordResponseDto` + `AuditPageResponseDto` with Swagger and JSDoc.
- **Docs**: README endpoint row (drop "planned") + audited actions + append-only note; constitution
  XI migration note → resolved (PATCH bump); `src/README.md` read path. No ADR (no new decision).

## Project Structure

```text
src/queries/{list-audit-records.query.ts,audit-record.read-model.ts}
src/repositories/audit-record.repository.ts
src/services/list-audit-records.service.ts
src/dto/{list-audit-records-query.dto.ts,audit-record-response.dto.ts,audit-page-response.dto.ts}
src/controllers/audit.controller.ts            # registered in app.module.ts
src/infra/database/migrations/<ts>-AddAuditRecordIndexes.ts
tests/integration/audit-record-repository.integration.spec.ts
tests/component/audit-list*.component.spec.ts  # list/filters, access/validation, status audit
```

## Complexity Tracking

None.
