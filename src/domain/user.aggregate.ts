import { randomUUID } from 'node:crypto';
import { Email } from './email.value-object';
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
