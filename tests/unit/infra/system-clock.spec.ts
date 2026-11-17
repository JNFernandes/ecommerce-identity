import { SystemClock } from '../../../src/infra/time/system-clock';
import { Clock } from '../../../src/services/ports/clock';

describe('SystemClock', () => {
  it('should be a Clock that returns the current time', () => {
    const clock = new SystemClock();
    const before = Date.now();

    const now = clock.now();

    expect(clock).toBeInstanceOf(Clock);
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('should return a new Date on every call', () => {
    const clock = new SystemClock();

    expect(clock.now()).not.toBe(clock.now());
  });
});
