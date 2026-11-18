import { randomUUID } from 'node:crypto';
import { Email } from './email.value-object';
import { CannotDisableSelfError } from './errors/cannot-disable-self.error';
import { InvalidCredentialsError } from './errors/invalid-credentials.error';
import { UserRegistered } from './events/user-registered.event';
import { Role } from './role.enum';
import { UserName } from './user-name.value-object';
import { UserStatus } from './user-status.enum';

/** Domain events the `User` aggregate can raise. */
export type UserDomainEvent = UserRegistered;

/** Full state of a user, as stored. */
export interface UserProps {
  /** User id (UUID). */
  id: string;
  /** Customer id (UUID), set for customers only; `null` for admins. */
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
    let customerId = randomUUID();
    while (customerId === id) {
      customerId = randomUUID();
    }
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

  /** Customer id (UUID), or `null` for a user without the customer role. */
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
   * Disables the account on behalf of an admin. Setting the status the user already has is a
   * no-op. The self rule is checked first, so it applies even when the user is already disabled.
   *
   * @param actingAdminId The id of the admin making the change.
   * @param at The change time, written to `updatedAt` only when the status changes.
   * @returns `true` when the status changed, `false` when the user was already `DISABLED`.
   * @throws CannotDisableSelfError When the admin targets their own account.
   */
  disable(actingAdminId: string, at: Date): boolean {
    if (this.props.id === actingAdminId) {
      throw new CannotDisableSelfError();
    }
    if (this.props.status === UserStatus.DISABLED) {
      return false;
    }
    this.props.status = UserStatus.DISABLED;
    this.props.updatedAt = at;
    return true;
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
