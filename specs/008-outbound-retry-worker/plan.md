# Implementation Plan: Retry failed user-registered events (US-08)

**Branch**: `feature/US-08-outbound-retry-worker` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-outbound-retry-worker/spec.md`

## Summary

`DeadLetterRetryWorker` (infra) runs a self-rescheduling timer and calls
`RetryOutboundEventsService.runBatch()`. The service repeats, up to `batchSize` times,
`OutboundDeadLetterRepository.processNextDue(handler)`: one transaction that claims one due
`identity.user-registered` row with `FOR UPDATE SKIP LOCKED`, republishes it through
`UserEventPublisher.republish(topic, key, payload)`, applies the pure domain `decideRetry`, and
writes the result. It logs one summary per run and one line per failure/exhaustion, never payloads.
No migration, no new package. Pattern follows Orders US-08. Decisions: [research.md](research.md).

**Deviations from the input** (both to stay correct / constitutional):
- Shutdown in `onModuleDestroy`, not `onApplicationShutdown`: the producer and TypeORM close in
  `onApplicationShutdown`, which could race the in-flight row (R3).
- Backoff/transition policy in the domain, not the service layer: constitution I (R5).
- No migration: every column the input lists already exists (R1).
- Claim is per row (one transaction each, up to `batchSize` per run), not one per batch (R4).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 20

**Primary Dependencies**: NestJS 10, TypeORM 0.3, `kafkajs` via `LazyKafkaProducer`. No new packages.

**Storage**: PostgreSQL `outbound_dead_letters` (existing, unchanged).

**Testing**: Jest; testcontainers PostgreSQL (integration) and PostgreSQL + Kafka (component).

**Target Platform**: Linux container / Node 20 server

**Project Type**: web service (NestJS microservice)

**Performance Goals**: drain 20 due rows per 30 s run per instance; one lock per attempt.

**Constraints**: never delays startup or health; no overlapping runs; payloads never logged.

**Scale/Scope**: rows exist only during Kafka outages; tens to hundreds at most.

## Constitution Check

| Principle | Status |
|---|---|
| I. Layering | ✅ worker (infra) → service (orchestration) → domain policy (pure) → repository / publisher port |
| II. Security | ✅ payload (email) never logged; no tokens/passwords involved |
| III. Authorization | ✅ no endpoint added |
| IV. Write flow | ✅ registration unchanged: commit → publish → dead-letter; worker only drains |
| V. Type safety | ✅ no `any`; payload typed as `Record<string, unknown>` and checked before publish |
| VI/VII. Tests | ✅ unit (policy, service, worker, config), integration (claim), component (Kafka) |
| VIII. Kafka | ✅ `FOR UPDATE SKIP LOCKED`, same `eventId`, exponential backoff, `RESOLVED`/`EXHAUSTED`, key = `aggregateId`, startup never waits for Kafka |
| IX. Branching | ✅ `feature/US-08-outbound-retry-worker`, `feat(US-08)` commits |
| X. Quality gate | ✅ build/lint/format/test after every task |

Post-design re-check: no violations; Complexity Tracking not needed.

## Project Structure

### Documentation (this feature)

```text
specs/008-outbound-retry-worker/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/retry-worker.md
└── tasks.md   (/speckit-tasks)
```

### Source Code

```text
src/
├── config/configuration.ts                      # + OutboundRetryConfig, validation (R8)
├── domain/outbound/retry-policy.ts               # NEW nextRetryDelay, decideRetry (pure)
├── services/
│   ├── ports/user-event-publisher.ts             # + republish(topic, key, payload)
│   └── retry-outbound-events.service.ts          # NEW runBatch(): claim → publish → decide → log
├── repositories/outbound-dead-letter.repository.ts  # + processNextDue(handler) SKIP LOCKED
├── infra/
│   ├── kafka/lazy-kafka-producer.ts              # + publishRaw(topic, key, value)
│   ├── kafka/user-events.producer.ts             # + republish
│   └── outbound/dead-letter-retry.worker.ts      # NEW timer, bootstrap/destroy hooks
└── app.module.ts                                 # register service + worker

tests/
├── unit/domain/outbound-retry-policy.spec.ts
├── unit/services/retry-outbound-events.service.spec.ts
├── unit/infra/dead-letter-retry.worker.spec.ts
├── unit/config/ (outbound retry settings)
├── integration/outbound-dead-letter-claim.integration.spec.ts
└── component/outbound-retry.component.spec.ts   # resolve after Kafka back, exhaust, 201 while down

docs: README (Events, Environment variables), src/README + infra/kafka/README,
docs/adr/0007-outbound-retry-per-row-skip-locked.md + index; ecommerce-infra/docs/events.md
(at-least-once redelivery note only; payload unchanged).
```

**Structure Decision**: single NestJS project; new code placed by layer as above.
