import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';
import { KafkaConfig } from '../../config/configuration';
import { KAFKA_PRODUCER } from './kafka.constants';
import { createKafkaLogCreator } from './kafka-log-creator';
import { LazyKafkaProducer } from './lazy-kafka-producer';

/**
 * Kafka producer wiring. Nothing here connects: the producer connects lazily on its first publish
 * (LazyKafkaProducer, which also disconnects it on shutdown), so the service starts even when
 * Kafka is down. Do not add awaited `connect()` calls to factories or lifecycle hooks.
 *
 * The client uses `retry.retries = KAFKA_PRODUCER_RETRIES` and `KAFKA_CONNECTION_TIMEOUT_MS`,
 * which bound how long a publish to an unreachable broker takes (about 3 s with the defaults).
 * kafkajs logs go through the Nest logger, with repeated connection failures throttled.
 */
@Global()
@Module({
  providers: [
    {
      provide: KAFKA_PRODUCER,
      useFactory: (configService: ConfigService): Producer => {
        const config = configService.getOrThrow<KafkaConfig>('kafka');
        const retry = { retries: config.producerRetries };
        return new Kafka({
          clientId: config.clientId,
          brokers: config.brokers,
          connectionTimeout: config.connectionTimeoutMs,
          retry,
          logCreator: createKafkaLogCreator(),
        }).producer({ retry });
      },
      inject: [ConfigService],
    },
    LazyKafkaProducer,
  ],
  exports: [LazyKafkaProducer],
})
export class KafkaModule {}
