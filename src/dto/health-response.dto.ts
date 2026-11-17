import { ApiProperty } from '@nestjs/swagger';
import { KafkaProducerState } from '../infra/kafka/kafka-producer-state.enum';

/** Overall health: `ok` when the database answers, `error` otherwise. */
export enum HealthStatus {
  OK = 'ok',
  ERROR = 'error',
}

/** Database reachability. */
export enum DatabaseState {
  UP = 'up',
  DOWN = 'down',
}

/** Response of `GET /health`. */
export class HealthResponseDto {
  @ApiProperty({
    enum: HealthStatus,
    description: 'ok when the database answers; Kafka never fails it',
  })
  status!: HealthStatus;

  @ApiProperty({ enum: DatabaseState, description: 'PostgreSQL reachability' })
  database!: DatabaseState;

  @ApiProperty({
    enum: KafkaProducerState,
    description:
      'Kafka producer state, informational only: idle until the first publish (lazy connect)',
  })
  kafka!: KafkaProducerState;
}
