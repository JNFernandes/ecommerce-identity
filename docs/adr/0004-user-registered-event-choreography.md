# 0004. Registration publishes `identity.user-registered`; Orders creates the customer

- **Status**: Accepted
- **Date**: 2026-11-17

## Context

Orders needs to know which customers exist (it keeps its own `customers` table), and
Notifications may want to greet new users. Registration happens in Identity. The platform rule
(`ecommerce-infra/docs/events.md`) is that services talk to each other only through Kafka events,
never by direct HTTP calls.

A direct call from Identity to Orders at registration would couple the two services' availability:
registration would fail, or need its own retry and compensation logic, whenever Orders is down.

## Decision

We will use **choreography**:

- After the new user is committed to PostgreSQL, Identity publishes `identity.user-registered`.
  Envelope: `eventId`, `aggregateId` (the user id, also the message key), `occurredAt`,
  `version`; payload: `customerId`, `email`, `name`.
- Orders consumes the event and creates its customer record from `customerId`, idempotently by
  `eventId`. Other services may subscribe without any change in Identity.
- A failed publish is logged, stored in the outbound dead-letter table and redelivered by the
  retry worker with the same `eventId` (at-least-once). Registration still succeeds.
- Identity starts and serves requests without Kafka; the producer connects lazily.

## Consequences

- Registration depends only on Identity and its database.
- Orders' customer list is **eventually consistent**: for a short time after registration (longer
  if Kafka is down) Orders may not know the customer yet. Orders must handle that case explicitly.
- The event carries personal data (`email`, `name`); consumers must treat it accordingly.
- Follow-ups outside this repository: add the topic and payload to `ecommerce-infra/docs/events.md`
  and to `kafka-init` in `docker-compose.yml`; add the consumer in `ecommerce-orders` (which today
  seeds customers itself).
