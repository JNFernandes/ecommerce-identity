import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LazyKafkaProducer } from '../infra/kafka/lazy-kafka-producer';
import { DatabaseState, HealthResponseDto, HealthStatus } from '../dto/health-response.dto';

/** How long the database probe may take before the database is reported down. */
export const DATABASE_PROBE_TIMEOUT_MS = 3_000;

/**
 * Builds the health report. Only the database decides the overall status: the service starts and
 * stays healthy without Kafka (Constitution Principle VIII), so the Kafka state is reported but
 * never fails the check, and reading it never opens a connection.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly kafkaProducer: LazyKafkaProducer,
  ) {}

  async check(): Promise<HealthResponseDto> {
    const database = await this.probeDatabase();
    return {
      status: database === DatabaseState.UP ? HealthStatus.OK : HealthStatus.ERROR,
      database,
      kafka: this.kafkaProducer.state,
    };
  }

  private async probeDatabase(): Promise<DatabaseState> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('database probe timed out')),
        DATABASE_PROBE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.dataSource.query('SELECT 1'), timeout]);
      return DatabaseState.UP;
    } catch {
      return DatabaseState.DOWN;
    } finally {
      clearTimeout(timer);
    }
  }
}
