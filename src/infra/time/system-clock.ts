import { Injectable } from '@nestjs/common';
import { Clock } from '../../services/ports/clock';

/** `Clock` backed by the system time. */
@Injectable()
export class SystemClock extends Clock {
  /** The current system time. */
  now(): Date {
    return new Date();
  }
}
