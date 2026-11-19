import { Role } from './role.enum';
import { User } from './user.aggregate';

/** What the startup admin seed must do. */
export enum AdminSeedDecision {
  /** No admin exists and the seed is configured: validate the values and look up the email. */
  PROCEED = 'PROCEED',
  /** Create the administrator. */
  CREATE = 'CREATE',
  /** An admin already exists (whatever its status): do nothing, silently. */
  SKIP_ADMIN_EXISTS = 'SKIP_ADMIN_EXISTS',
  /** No admin exists but `ADMIN_EMAIL` or `ADMIN_PASSWORD` is unset: warn and do nothing. */
  SKIP_NOT_CONFIGURED = 'SKIP_NOT_CONFIGURED',
  /** The email belongs to an existing non-admin user: log an error, never modify that user. */
  SKIP_EMAIL_TAKEN = 'SKIP_EMAIL_TAKEN',
}

/** Input of {@link AdminSeedPolicy.precheck}. */
export interface AdminSeedPrecheckInput {
  /** Whether any user holds `ADMIN`, whatever its status. */
  adminExists: boolean;
  /** Whether both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set and non-empty. */
  configured: boolean;
}

/** Input of {@link AdminSeedPolicy.decide}. */
export interface AdminSeedDecideInput {
  /** The user that already owns the seed email, or `null` when the email is free. */
  emailOwner: User | null;
}

/**
 * The admin seed rules. Admins are only ever created, never promoted or modified: the seed runs
 * only when no admin exists, and an email already taken by any user stops it. Pure; the service
 * only carries out the decisions.
 */
export class AdminSeedPolicy {
  private constructor() {}

  /**
   * Decides whether the seed goes on, before any value is validated: an existing admin wins over
   * a missing configuration, so a deployment that removed `ADMIN_PASSWORD` stays silent.
   *
   * @param input Whether an admin exists and whether the seed variables are set.
   * @returns `SKIP_ADMIN_EXISTS`, `SKIP_NOT_CONFIGURED` or `PROCEED`.
   */
  static precheck({ adminExists, configured }: AdminSeedPrecheckInput): AdminSeedDecision {
    if (adminExists) {
      return AdminSeedDecision.SKIP_ADMIN_EXISTS;
    }
    if (!configured) {
      return AdminSeedDecision.SKIP_NOT_CONFIGURED;
    }
    return AdminSeedDecision.PROCEED;
  }

  /**
   * Decides, once the values are valid, whether the administrator can be created. An admin owning
   * the email means another instance seeded it after `precheck` (concurrent startup), so it counts
   * as an existing admin, not as a taken email.
   *
   * @param input The current owner of the seed email, if any.
   * @returns `SKIP_ADMIN_EXISTS` when the owner is an admin, `SKIP_EMAIL_TAKEN` when another user
   *   owns the email, otherwise `CREATE`.
   */
  static decide({ emailOwner }: AdminSeedDecideInput): AdminSeedDecision {
    if (emailOwner === null) {
      return AdminSeedDecision.CREATE;
    }
    return emailOwner.roles.includes(Role.ADMIN)
      ? AdminSeedDecision.SKIP_ADMIN_EXISTS
      : AdminSeedDecision.SKIP_EMAIL_TAKEN;
  }
}
