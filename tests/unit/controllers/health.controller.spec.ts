import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../../../src/controllers/health.controller';
import { HealthService } from '../../../src/services/health.service';
import {
  DatabaseState,
  HealthResponseDto,
  HealthStatus,
} from '../../../src/dto/health-response.dto';
import { KafkaProducerState } from '../../../src/infra/kafka/kafka-producer-state.enum';

describe('HealthController', () => {
  let check: jest.Mock<Promise<HealthResponseDto>, []>;
  let controller: HealthController;

  beforeEach(() => {
    check = jest.fn();
    controller = new HealthController({ check } as unknown as HealthService);
  });

  it('should return the report when the service is healthy', async () => {
    const report: HealthResponseDto = {
      status: HealthStatus.OK,
      database: DatabaseState.UP,
      kafka: KafkaProducerState.IDLE,
    };
    check.mockResolvedValue(report);

    await expect(controller.check()).resolves.toEqual(report);
  });

  it('should answer 503 with the report when the database is down', async () => {
    const report: HealthResponseDto = {
      status: HealthStatus.ERROR,
      database: DatabaseState.DOWN,
      kafka: KafkaProducerState.IDLE,
    };
    check.mockResolvedValue(report);

    const error = await controller.check().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual(report);
  });
});
