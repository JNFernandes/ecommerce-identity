import { Column, Entity, PrimaryColumn } from 'typeorm';
import { Role } from '../../../domain/role.enum';
import { UserStatus } from '../../../domain/user-status.enum';

/**
 * Persistence shape of a user (`users` table). Separate from the `User` aggregate and mapped
 * explicitly by `UserRepository`. Email uniqueness is the case-insensitive index
 * `UQ_users_email_lower` on `lower(email)`, created by the migration.
 */
@Entity('users')
export class UserEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** Customer id; `null` for admins, unique otherwise. */
  @Column({ type: 'uuid', nullable: true, unique: true })
  customerId!: string | null;

  /** Normalized (trimmed, lowercase) email. */
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /** argon2id PHC string. Never returned or logged. */
  @Column({ type: 'text' })
  passwordHash!: string;

  @Column({ type: 'enum', enum: Role, enumName: 'user_role_enum', array: true })
  roles!: Role[];

  @Column({ type: 'enum', enum: UserStatus, enumName: 'user_status_enum' })
  status!: UserStatus;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz' })
  updatedAt!: Date;

  /** Time of the last successful login; `null` until the first one. */
  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;
}
