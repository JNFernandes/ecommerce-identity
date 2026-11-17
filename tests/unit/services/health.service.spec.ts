import { DataSource } from 'typeorm';
import { DATABASE_PROBE_TIMEOUT_MS, HealthService } from '../../../src/services/health.service';
import { LazyKafkaProducer } from '../../../src/infra/kafka/lazy-kafka-producer';
import { KafkaProducerState } from '../../../src/infra/kafka/kafka-producer-state.enum';
import { DatabaseState, HealthStatus } from '../../../src/dto/health-response.dto';

describe('HealthService', () => {
  let query: jest.Mock;
  let kafkaState: KafkaProducerState;
  let service: HealthService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    kafkaState = KafkaProducerState.IDLE;
    const producer = {
      get state(): KafkaProducerState {
        return kafkaState;
      },
    } as unknown as LazyKafkaProducer;
    service = new HealthService({ query } as unknown as DataSource, producer);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should report ok when the database answers', async () => {
    await expect(service.check()).resolves.toEqual({
      status: HealthStatus.OK,
      database: DatabaseState.UP,
      kafka: KafkaProducerState.IDLE,
    });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('should stay ok when Kafka is unavailable', async () => {
    kafkaState = KafkaProducerState.UNAVAILABLE;

    const report = await service.check();

    expect(report.status).toBe(HealthStatus.OK);
    expect(report.kafka).toBe(KafkaProducerState.UNAVAILABLE);
  });

  it('should report error when the database query fails', async () => {
    query.mockRejectedValue(new Error('connection refused'));

    await expect(service.check()).resolves.toMatchObject({
      status: HealthStatus.ERROR,
      database: DatabaseState.DOWN,
    });
  });

  it('should report the database down when the probe does not answer in time', async () => {
    jest.useFakeTimers();
    query.mockReturnValue(new Promise(() => undefined));

    const pending = service.check();
    await jest.advanceTimersByTimeAsync(DATABASE_PROBE_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({
      status: HealthStatus.ERROR,
      database: DatabaseState.DOWN,
    });
  });
});
