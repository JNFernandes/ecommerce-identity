import { LastActiveAdminError } from './errors/last-active-admin.error';
import { User } from './user.aggregate';

/** Input of {@link LastActiveAdminPolicy.assertCanDisable}. */
export interface LastActiveAdminInput {
  /** The user about to be disabled, as read before the change. */
  target: User;
  /** Number of `ACTIVE` admins, read before the change and including the target. */
  activeAdminCount: number;
}

/** Keeps at least one `ACTIVE` admin, so someone can always manage accounts. */
export class LastActiveAdminPolicy {
  private constructor() {}

  /**
   * Refuses to disable the last `ACTIVE` admin. Any other target (a customer, an already disabled
   * admin) passes whatever the count.
   *
   * @param input The target before the change and the current number of `ACTIVE` admins.
   * @throws LastActiveAdminError When the target is an `ACTIVE` admin and no other one exists.
   */
  static assertCanDisable({ target, activeAdminCount }: LastActiveAdminInput): void {
    if (target.isActiveAdmin() && activeAdminCount <= 1) {
      throw new LastActiveAdminError();
    }
  }
}
