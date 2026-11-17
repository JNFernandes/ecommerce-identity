import { LoggerService } from '@nestjs/common';

/**
 * A `LoggerService` that keeps every line it receives, so component tests can assert that no
 * secret ever reaches the logs.
 */
export class CapturingLogger implements LoggerService {
  /** Every logged line: level, message and optional parameters, serialized. */
  readonly lines: string[] = [];

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('fatal', message, optionalParams);
  }

  /** All captured lines joined, for `not.toContain` checks. */
  text(): string {
    return this.lines.join('\n');
  }

  private capture(level: string, message: unknown, optionalParams: unknown[]): void {
    const parts = [message, ...optionalParams].map((part) =>
      part instanceof Error
        ? `${part.name}: ${part.message}\n${part.stack ?? ''}`
        : stringify(part),
    );
    this.lines.push(`[${level}] ${parts.join(' ')}`);
  }
}

/** Serializes any value, falling back to `String` when it cannot be turned into JSON. */
function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
