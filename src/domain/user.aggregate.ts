import { randomUUID } from 'node:crypto';
import { Email } from './email.value-object';
import { CannotDisableSelfError } from './errors/cannot-disable-self.error';
import { CannotRemoveOwnAdminError } from './errors/cannot-remove-own-admin.error';
import { InvalidCredentialsError } from './errors/invalid-credentials.error';
import { UserValidationError } from './errors/user-validation.error';
import { UserRegistered } from './events/user-registered.event';
import { Role } from './role.enum';
import { UserName } from './user-name.value-object';
import { UserStatus } from './user-status.enum';

/** Domain events the `User` aggregate can raise. */
export type UserDomainEvent = UserRegistered;

/** What {@link User.changeRoles} did. */
export interface RoleChangeResult {
  /** Whether the roles changed; `false` for a no-op (same set of roles). */
  changed: boolean;
  /** The roles the user lost, empty for a grant-only change. */
  removed: Role[];
  /** Whether a new `customerId` was created (first `CUSTOMER` grant, `UserRegistered` recorded). */
  customerCreated: boolean;
}

/** Full state of a user, as stored. */
export interface UserProps {
  /** User id (UUID). */
  id: string;
  /**
   * Customer id (UUID), created with the first `CUSTOMER` role and never removed; `null` for a user
   * who never held `CUSTOMER`. Dormant while the roles do not include `CUSTOMER`.
   */
  customerId: string | null;
  /** Normalized email, unique case-insensitively. */
  email: Email;
  /** Trimmed display name. */
  name: UserName;
  /** argon2id hash of the password; the plain password is never kept. */
  passwordHash: string;
  /** Roles the user holds. */
  roles: Role[];
  /** Account status. */
  status: UserStatus;
  /** Creation time. */
  createdAt: Date;
  /** Last update time. */
  updatedAt: Date;
  /** Time of the last successful login; `null` until the first one. */
  lastLoginAt: Date | null;
}

/** The user aggregate: an account that holds credentials and roles. */
export class User {
  private domainEvents: UserDomainEvent[] = [];

  private constructor(private readonly props: UserProps) {}

  /**
   * Creates a new customer: new `id` and `customerId` (always different), role `CUSTOMER`, status
   * `ACTIVE`. Records a `UserRegistered` event.
   *
   * @param email The validated, normalized email.
   * @param name The validated, trimmed name.
   * @param passwordHash The argon2id hash of a password that passed `PasswordPolicy`.
   */
  static registerCustomer(email: Email, name: UserName, passwordHash: string): User {
    const id = randomUUID();
    const customerId = User.newCustomerId(id);
    const now = new Date();
    const user = new User({
      id,
      customerId,
      email,
      name,
      passwordHash,
      roles: [Role.CUSTOMER],
      status: UserStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    });
    user.domainEvents.push(
      new UserRegistered({
        aggregateId: id,
        customerId,
        email: email.value,
        name: name.value,
        occurredAt: now,
      }),
    );
    return user;
  }

  /**
   * Creates the administrator seeded at startup: new `id`, no `customerId`, role `ADMIN`, status
   * `ACTIVE`. Raises **no** event: admins are not customers, so no `UserRegistered` is published.
   *
   * @param email The validated, normalized email.
   * @param name The validated, trimmed name.
   * @param passwordHash The argon2id hash of a password that passed `PasswordPolicy`.
   */
  static registerAdmin(email: Email, name: UserName, passwordHash: string): User {
    return User.newAdmin(email, name, passwordHash);
  }

  /**
   * Creates a user on an admin's request (`POST /users`). One role per user: exactly
   * `[CUSTOMER]` creates a customer as registration does (new `customerId`, records
   * `UserRegistered`); exactly `[ADMIN]` creates an admin (no `customerId`, no event).
   *
   * @param email The validated, normalized email.
   * @param name The validated, trimmed name.
   * @param passwordHash The argon2id hash of a password that passed `PasswordPolicy`.
   * @param roles The requested roles.
   * @throws UserValidationError When `roles` is not exactly `[CUSTOMER]` or `[ADMIN]`.
   */
  static createByAdmin(
    email: Email,
    name: UserName,
    passwordHash: string,
    roles: readonly Role[],
  ): User {
    const role = User.assertRolesForAdminCreation(roles);
    return role === Role.CUSTOMER
      ? User.registerCustomer(email, name, passwordHash)
      : User.newAdmin(email, name, passwordHash);
  }

  /**
   * Checks the one-role-per-user rule of {@link User.createByAdmin} on its own, so a caller can
   * reject bad roles before paying for anything else (e.g. password hashing).
   *
   * @param roles The requested roles.
   * @returns The single role.
   * @throws UserValidationError When `roles` is not exactly `[CUSTOMER]` or `[ADMIN]`.
   */
  static assertRolesForAdminCreation(roles: readonly Role[]): Role {
    if (roles.length === 1 && (roles[0] === Role.CUSTOMER || roles[0] === Role.ADMIN)) {
      return roles[0];
    }
    throw new UserValidationError('roles must be exactly one of CUSTOMER or ADMIN');
  }

  /** A new customer id, always different from the user id. */
  private static newCustomerId(userId: string): string {
    let customerId = randomUUID();
    while (customerId === userId) {
      customerId = randomUUID();
    }
    return customerId;
  }

  /** A new `ACTIVE` admin without `customerId` and without event. */
  private static newAdmin(email: Email, name: UserName, passwordHash: string): User {
    const now = new Date();
    return new User({
      id: randomUUID(),
      customerId: null,
      email,
      name,
      passwordHash,
      roles: [Role.ADMIN],
      status: UserStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    });
  }

  /**
   * Rebuilds a user from persisted state. Raises no event.
   *
   * @param props The stored state.
   */
  static restore(props: UserProps): User {
    return new User({ ...props, roles: [...props.roles] });
  }

  /** User id (UUID). */
  get id(): string {
    return this.props.id;
  }

  /**
   * Customer id (UUID), or `null` for a user who never held the customer role. May be dormant: see
   * {@link User.activeCustomerId}.
   */
  get customerId(): string | null {
    return this.props.customerId;
  }

  /** Normalized email. */
  get email(): Email {
    return this.props.email;
  }

  /** Trimmed display name. */
  get name(): UserName {
    return this.props.name;
  }

  /** argon2id hash of the password. Never returned or logged. */
  get passwordHash(): string {
    return this.props.passwordHash;
  }

  /** A copy of the user's roles. */
  get roles(): Role[] {
    return [...this.props.roles];
  }

  /** Account status. */
  get status(): UserStatus {
    return this.props.status;
  }

  /** Creation time. */
  get createdAt(): Date {
    return this.props.createdAt;
  }

  /** Last update time. */
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  /** Time of the last successful login, or `null` if the user never logged in. */
  get lastLoginAt(): Date | null {
    return this.props.lastLoginAt;
  }

  /** The customer id when the roles include `CUSTOMER`, else `null` (a dormant id is hidden). */
  get activeCustomerId(): string | null {
    return this.props.roles.includes(Role.CUSTOMER) ? this.props.customerId : null;
  }

  /** Whether the user may log in: only `ACTIVE` users can. */
  canLogin(): boolean {
    return this.props.status === UserStatus.ACTIVE;
  }

  /**
   * Records a successful login. Leaves `updatedAt` unchanged, because a login does not change the
   * account.
   *
   * @param at The login time.
   * @throws InvalidCredentialsError When the user may not log in (see {@link User.canLogin}).
   */
  recordLogin(at: Date): void {
    if (!this.canLogin()) {
      throw new InvalidCredentialsError();
    }
    this.props.lastLoginAt = at;
  }

  /** Whether the user is an `ACTIVE` holder of the `ADMIN` role. */
  isActiveAdmin(): boolean {
    return this.props.status === UserStatus.ACTIVE && this.props.roles.includes(Role.ADMIN);
  }

  /**
   * Checks the self rule of {@link User.disable} without changing anything, so callers can apply
   * other checks (such as `LastActiveAdminPolicy`) after it and before the change.
   *
   * @param actingAdminId The id of the admin making the change.
   * @throws CannotDisableSelfError When the admin targets their own account.
   */
  assertCanBeDisabledBy(actingAdminId: string): void {
    if (this.props.id === actingAdminId) {
      throw new CannotDisableSelfError();
    }
  }

  /**
   * Disables the account on behalf of an admin. Setting the status the user already has is a
   * no-op. The self rule is checked first, so it applies even when the user is already disabled.
   *
   * @param actingAdminId The id of the admin making the change.
   * @param at The change time, written to `updatedAt` only when the status changes.
   * @returns `true` when the status changed, `false` when the user was already `DISABLED`.
   * @throws CannotDisableSelfError When the admin targets their own account.
   */
  disable(actingAdminId: string, at: Date): boolean {
    this.assertCanBeDisabledBy(actingAdminId);
    if (this.props.status === UserStatus.DISABLED) {
      return false;
    }
    this.props.status = UserStatus.DISABLED;
    this.props.updatedAt = at;
    return true;
  }

  /**
   * Re-enables the account. Setting the status the user already has is a no-op. Refresh tokens
   * revoked by an earlier disable stay revoked; the user logs in again.
   *
   * @param at The change time, written to `updatedAt` only when the status changes.
   * @returns `true` when the status changed, `false` when the user was already `ACTIVE`.
   */
  enable(at: Date): boolean {
    if (this.props.status === UserStatus.ACTIVE) {
      return false;
    }
    this.props.status = UserStatus.ACTIVE;
    this.props.updatedAt = at;
    return true;
  }

  /**
   * Checks rules 1 to 3 of {@link User.changeRoles} without changing anything, so callers can apply
   * other checks (such as `LastActiveAdminPolicy`) after it and before the change.
   *
   * @param roles The requested roles.
   * @param actingAdminId The id of the admin making the change.
   * @returns Whether the roles would change and which roles would be removed.
   * @throws UserValidationError When `roles` is empty, repeats a role or holds an unknown one.
   * @throws CannotRemoveOwnAdminError When the admin removes `ADMIN` from themselves.
   */
  previewRoleChange(
    roles: readonly Role[],
    actingAdminId: string,
  ): Pick<RoleChangeResult, 'changed' | 'removed'> {
    const known: readonly string[] = Object.values(Role);
    if (
      roles.length === 0 ||
      new Set(roles).size !== roles.length ||
      roles.some((role) => !known.includes(role))
    ) {
      throw new UserValidationError('roles must be a non-empty list of distinct CUSTOMER or ADMIN');
    }
    const current = this.props.roles;
    const removed = current.filter((role) => !roles.includes(role));
    const added = roles.filter((role) => !current.includes(role));
    if (removed.length === 0 && added.length === 0) {
      return { changed: false, removed: [] };
    }
    if (removed.includes(Role.ADMIN) && this.props.id === actingAdminId) {
      throw new CannotRemoveOwnAdminError();
    }
    return { changed: true, removed };
  }

  /**
   * Replaces the user's roles on behalf of an admin. Rules, in order:
   *
   * 1. `roles` must be a non-empty list of distinct known roles.
   * 2. The same set of roles (order ignored) is a no-op, checked before the safeguards.
   * 3. An admin cannot remove `ADMIN` from themselves.
   * 4. A first `CUSTOMER` grant to a user without `customerId` creates one (different from the
   *    id) and records a `UserRegistered` event; an existing `customerId` is reused, and removing
   *    `CUSTOMER` keeps it. `ADMIN` never touches it.
   *
   * The last-active-admin rule needs a count and lives in `LastActiveAdminPolicy`; callers apply it
   * when `ADMIN` is removed, before persisting.
   *
   * @param roles The requested roles.
   * @param actingAdminId The id of the admin making the change.
   * @param at The change time, written to `updatedAt` (and the event) only when the roles change.
   * @returns What changed.
   * @throws UserValidationError When `roles` is empty, repeats a role or holds an unknown one.
   * @throws CannotRemoveOwnAdminError When the admin removes `ADMIN` from themselves.
   */
  changeRoles(roles: readonly Role[], actingAdminId: string, at: Date): RoleChangeResult {
    const { changed, removed } = this.previewRoleChange(roles, actingAdminId);
    if (!changed) {
      return { changed: false, removed: [], customerCreated: false };
    }
    const added = roles.filter((role) => !this.props.roles.includes(role));

    let customerCreated = false;
    if (added.includes(Role.CUSTOMER) && this.props.customerId === null) {
      const customerId = User.newCustomerId(this.props.id);
      this.props.customerId = customerId;
      customerCreated = true;
      this.domainEvents.push(
        new UserRegistered({
          aggregateId: this.props.id,
          customerId,
          email: this.props.email.value,
          name: this.props.name.value,
          occurredAt: at,
        }),
      );
    }
    this.props.roles = [...roles];
    this.props.updatedAt = at;
    return { changed: true, removed, customerCreated };
  }

  /**
   * Returns the events raised since the last call and clears them, so each event is published
   * once.
   */
  pullDomainEvents(): UserDomainEvent[] {
    const events = this.domainEvents;
    this.domainEvents = [];
    return events;
  }
}
