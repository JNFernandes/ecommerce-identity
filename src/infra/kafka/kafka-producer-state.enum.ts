/** Connection state of the lazily connected Kafka producer, as reported by `GET /health`. */
export enum KafkaProducerState {
  /** No publish has happened yet, so no connection was attempted. */
  IDLE = 'idle',
  /** The producer is connected. */
  CONNECTED = 'connected',
  /** The last connection attempt failed; the next publish tries again. */
  UNAVAILABLE = 'unavailable',
}
