# KafkaModule

**Responsibility:** provides `LazyKafkaProducer`, the only way this service publishes to Kafka.

- Nothing connects at bootstrap. The first `publish()` opens the connection; concurrent publishes
  share one attempt; a failed attempt is cleared so the next publish retries. The service starts
  and stays healthy without Kafka (Constitution Principle VIII).
- Publish latency against an unreachable broker is bounded by `KAFKA_CONNECTION_TIMEOUT_MS` and
  `KAFKA_PRODUCER_RETRIES` (about 3 s with the defaults).
- Messages are JSON, keyed by the event's `aggregateId`.
- `state` (`idle`, `connected`, `unavailable`) feeds `GET /health` without connecting.
- kafkajs logs go through the Nest logger, with repeated connection failures throttled
  (`kafka-log-creator.ts`).

**Endpoints:** none. **Events produced:** `identity.user-registered` (`UserEventsProducer`, adapter of the `UserEventPublisher` port).
