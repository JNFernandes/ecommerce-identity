import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthService } from '../services/health.service';
import { HealthResponseDto, HealthStatus } from '../dto/health-response.dto';

/** Public liveness/readiness endpoint, used by the Docker healthcheck. */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** Returns 200 when the database answers and 503 otherwise; Kafka never fails the check. */
  @Get()
  @ApiOkResponse({ type: HealthResponseDto, description: 'The database answers' })
  @ApiServiceUnavailableResponse({ type: HealthResponseDto, description: 'The database is down' })
  async check(): Promise<HealthResponseDto> {
    const report = await this.healthService.check();
    if (report.status !== HealthStatus.OK) {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
