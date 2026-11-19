# Feature Specification: Retry failed user-registered events (US-08)

**Feature Branch**: `feature/US-08-outbound-retry-worker`

**Created**: 2026-11-19

**Status**: Draft

**Input**: User description: "US-08: Retry delivery of identity.user-registered events that failed
to publish (outbound dead-letter retry worker). A background worker redelivers events that US-01
stored in the outbound dead-letter table, so no registration is lost while the message broker is
unavailable. Reuse the existing table; extend it only if a column is missing. Polls on a
configurable interval, claims due rows so several instances never process the same row, republishes
the stored payload/topic/key unchanged (at-least-once), marks Resolved / backs off exponentially /
marks Exhausted after max attempts, never blocks or crashes the service, shuts down gracefully,
configured by environment variables with documented defaults, logs per batch and per failure without
payloads. Out of scope: manual replay API, alerting, purging old rows, retrying other topics."

## Clarifications

### Session 2026-11-19

- Q: Which store holds the events to retry? → A: The existing outbound dead-letter table from US-01; no new store.
- Q: Which final status values are used? → A: Resolved and Exhausted (existing status values, alongside Pending Retry).
- Q: May payloads appear in logs? → A: Never; only row id, `eventId` and other non-payload context.
- Q: How is polling scheduled? → A: A simple in-process timer inside each service instance; no external scheduler.
- Q: Default settings? → A: Interval 30 s, batch size 20, maximum attempts 10, base delay 5 s, multiplier 2, maximum delay 5 min.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A missed registration event is eventually delivered (Priority: P1)

A customer registers while the message broker is down. Registration succeeds (201) and the event is
stored as pending retry. Once the broker is back, the worker picks the row up on its next due poll,
republishes the stored event unchanged, and marks the row resolved. Orders then creates the customer.

**Why this priority**: This is the whole point of the story: without it a registration made during a
broker outage never reaches Orders.

**Independent Test**: Insert a due pending row (or register with the broker stopped), start the
broker, wait one poll interval, and check that exactly the stored message (same topic, key and
`eventId`) is on the topic and the row is Resolved with `resolvedAt` set.

**Acceptance Scenarios**:

1. **Given** a pending row whose next retry time has passed and a reachable broker, **When** the
   worker polls, **Then** it publishes the stored payload to the stored topic with the stored key,
   with the same fields and values (field order may differ), and marks the row Resolved with `resolvedAt` set.
2. **Given** a pending row whose next retry time is in the future, **When** the worker polls,
   **Then** the row is not attempted.
3. **Given** rows that are Resolved or Exhausted, **When** the worker polls, **Then** they are never
   attempted again.
4. **Given** more due rows than the batch size, **When** the worker polls, **Then** it attempts at
   most one batch, oldest-due first, and the rest on later polls.

---

### User Story 2 - Failures back off and eventually stop (Priority: P1)

While the broker stays unreachable, each attempt fails; the row records the attempt and error and is
rescheduled with exponentially growing delays, capped at a maximum. After the configured maximum
number of attempts the row is marked Exhausted, logged at error level, and left for manual inspection.

**Why this priority**: Without backoff and a stop condition, an outage turns into a tight retry loop
and rows that can never succeed are retried forever.

**Independent Test**: With the broker stopped, let a due row be attempted repeatedly (short
configured delays) and check `retryCount`, `lastError`, `lastAttemptAt` and `nextRetryAt` after each
attempt, then the Exhausted transition and the error log line.

**Acceptance Scenarios**:

1. **Given** a due pending row and an unreachable broker, **When** the attempt fails, **Then**
   `retryCount` increases by one, `lastError` and `lastAttemptAt` are updated, the row stays
   Pending Retry, and `nextRetryAt` = attempt time + min(base delay × multiplier^(retryCount − 1),
   max delay).
2. **Given** a row whose failed attempt brings `retryCount` to the maximum number of attempts,
   **When** the attempt fails, **Then** the row is marked Exhausted, is never attempted again, and
   one error-level log line records its id, `eventId`, topic, attempts made and last error.
3. **Given** one row in a batch fails and another succeeds, **When** the batch completes, **Then**
   each row gets its own outcome; one failure does not affect the others.

---

### User Story 3 - Safe with several instances and on shutdown (Priority: P2)

Two or more service instances run the worker against the same database. A due row is attempted by
only one of them per poll. When an instance shuts down, rows it was working on are either finished or
left due for another instance; none is lost or stuck.

**Why this priority**: Required for horizontal scaling and rolling deploys, but a single instance
already delivers the core value.

**Independent Test**: Run two workers concurrently against the same set of due rows and check that
each row is attempted once; stop a worker mid-batch and check that unfinished rows are still Pending
Retry and get picked up afterwards.

**Acceptance Scenarios**:

1. **Given** two instances polling at the same moment over the same due rows, **When** both claim a
   batch, **Then** no row is claimed by both, and each row is published once by that poll.
2. **Given** an instance stopping while a batch is in progress, **When** shutdown completes,
   **Then** every row of that batch is either finalised (Resolved / rescheduled / Exhausted) or left
   Pending Retry and due, and no new batch is started after shutdown begins.
3. **Given** an instance that crashes mid-batch, **When** another instance next polls, **Then** the
   rows that were not finalised are claimable again.

---

### User Story 4 - The worker never harms the service (Priority: P2)

The service starts, stays healthy and keeps returning 201 on registration regardless of the broker's
state or of errors inside the worker.

**Why this priority**: The constitution forbids the broker from blocking startup or health; the
worker must not reintroduce that dependency.

**Independent Test**: Start the service with the broker down and due rows present; check that
startup completes, health reports up (database reachable), registration returns 201, and the worker
keeps polling and backing off without crashing the process.

**Acceptance Scenarios**:

1. **Given** the broker is unreachable at startup, **When** the service starts, **Then** startup
   does not wait for the broker and the worker's first poll does not delay readiness.
2. **Given** a poll fails unexpectedly (for example the database is briefly unreachable), **When**
   the error occurs, **Then** it is logged and the next poll runs on schedule; the process keeps
   running.
3. **Given** a poll is still running when the next interval elapses, **When** the timer fires,
   **Then** no overlapping poll starts in the same instance.

### Edge Cases

- A stored row whose payload is malformed (no string `eventId`): it cannot succeed, so its first
  attempt marks it Exhausted; it never stops the batch or the worker.
- The broker accepts a message but the status update afterwards fails: the row stays pending and is
  published again later (duplicate tolerated; consumers deduplicate by `eventId`).
- A row for a topic other than `identity.user-registered`: only that topic is retried; other rows are
  left untouched.
- Maximum attempts set to 1: the first failed attempt exhausts the row.
- Backoff growth reaching the maximum delay: every later delay equals the maximum delay.
- Invalid configuration (non-positive interval, batch size or attempts, multiplier < 1, max delay <
  base delay): the service refuses to start with a clear message naming the setting.
- Many rows due after a long outage: they drain one batch per poll, so the broker and database are
  not flooded.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The service MUST run a background worker, driven by a simple in-process timer in each
  instance (no external scheduler), that polls every configured interval for rows
  of the existing outbound dead-letter store with status Pending Retry, topic
  `identity.user-registered` and `nextRetryAt` ≤ now. No second store or mechanism is introduced.
- **FR-002**: Each poll MUST claim at most the configured batch size of due rows, oldest
  `nextRetryAt` first, in a way that guarantees that concurrently polling instances never claim the
  same row.
- **FR-003**: For each claimed row the worker MUST publish the stored payload unchanged to the stored
  topic with the stored message key, so the `eventId` is identical to the original. Delivery is
  at-least-once.
- **FR-004**: On success the row MUST be marked Resolved with `resolvedAt` and `lastAttemptAt` set,
  and `retryCount` incremented.
- **FR-005**: On failure the worker MUST increment `retryCount`, set `lastAttemptAt`, store the
  failure as `lastError`, and set `nextRetryAt` = attempt time + min(base delay ×
  multiplier^(retryCount − 1), max delay).
- **FR-006**: When a failed attempt brings `retryCount` to the configured maximum, the row MUST be
  marked Exhausted instead of rescheduled, never attempted again, kept in the store, and logged once
  at error level with row id, `eventId`, topic, key, attempts and last error.
- **FR-007**: Resolved and Exhausted rows MUST never be claimed again.
- **FR-008**: Each row's outcome MUST be independent: a failure on one row MUST NOT prevent the
  others in the batch from being attempted or recorded.
- **FR-009**: The worker MUST NOT delay startup, MUST NOT affect the health result (only the database
  can fail health), MUST NOT affect registration, and MUST catch and log any error so the process
  never crashes because of it.
- **FR-010**: A single instance MUST NOT start a new poll while its previous poll is still running.
- **FR-011**: On shutdown the worker MUST stop starting new polls, let the in-progress batch finish
  within a bounded time, and leave any row it did not finalise Pending Retry and due again; no row
  may be left claimed or in an intermediate state.
- **FR-012**: An enabled flag, the interval, batch size, maximum attempts, base delay, multiplier,
  maximum delay and shutdown wait MUST come from environment variables with local defaults (enabled
  true, interval 30 s, batch size 20, maximum attempts 10, base delay 5 s, multiplier 2, maximum
  delay 5 min, shutdown wait 10 s) and MUST be documented in the README. Invalid values MUST stop
  startup with a message naming the variable.
- **FR-013**: The worker MUST log one info line per non-empty batch with counts claimed, resolved,
  failed (rescheduled) and exhausted, and one warning line per failed attempt that is rescheduled,
  with row id, `eventId`, topic, key, attempt number and next attempt time (an attempt that
  exhausts the row logs at error level instead, FR-006). Empty polls MUST NOT log at info level.
- **FR-014**: Logs MUST never contain the payload or any field of it (it contains email addresses);
  only row id, `eventId`, topic, key (the user id), counts, times and error messages.
- **FR-015**: Out of scope: a manual replay endpoint, alerting, purging old rows, and retrying any
  topic other than `identity.user-registered`.

### Key Entities

- **Outbound dead-letter row** (existing, unchanged): an event that failed to publish after its
  commit. Attributes used: id, `eventId`, topic, key, payload, status (Pending Retry / Resolved /
  Exhausted), `retryCount`, `nextRetryAt`, `lastAttemptAt`, `lastError`, `resolvedAt`, `createdAt`.
  All are already present, so no schema change is needed.
- **Retry policy**: the configured interval, batch size, maximum attempts, base delay, multiplier and
  maximum delay; it decides each row's next state after an attempt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After the broker becomes reachable, 100% of due pending rows within one batch are
  delivered and marked Resolved within one poll interval (default 30 s).
- **SC-002**: With two instances polling the same due rows, 0 rows are attempted by both instances in
  the same poll.
- **SC-003**: Every delivered retry carries the same `eventId`, key and payload as the stored row
  (100% match).
- **SC-004**: With the broker down for the whole test, the service starts, health stays up and
  registration returns 201 in 100% of attempts; the process never exits because of the worker.
- **SC-005**: A row that keeps failing reaches Exhausted after exactly the configured maximum number of
  attempts, with delays matching the backoff formula (within one poll interval).
- **SC-006**: No log line produced by the worker contains a payload field (checked by tests on
  captured logs).

## Assumptions

- The existing `outbound_dead_letters` table already has every needed column (`status`,
  `retryCount`, `nextRetryAt`, `lastAttemptAt`, `lastError`, `resolvedAt`), so no migration is
  added.
- `retryCount` counts worker attempts only; the original failed publish in US-01 is not counted, so
  maximum attempts = number of retries.
- `retryCount` is also incremented on success, so it always equals the attempts made.
- Rows are processed oldest-due first; strict global ordering across instances is not guaranteed.
- The worker is enabled in every instance; no leader election (row claiming makes it safe).
- The shutdown wait is bounded by `OUTBOUND_RETRY_SHUTDOWN_TIMEOUT_MS` (default 10 s); rows not finalised by then are
  released, not marked failed.
- With the defaults (10 attempts, 5 s base, ×2, 5 min cap) the delays between attempts are 5, 10,
  20, 40, 80, 160, 300, 300 and 300 s, so a row that keeps failing is exhausted about 20 minutes
  (plus up to one poll interval per attempt) after its first retry.
