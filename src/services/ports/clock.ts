/** Port for the current time, so services stay deterministic under test. Used as the Nest token. */
export abstract class Clock {
  /** The current time. */
  abstract now(): Date;
}
