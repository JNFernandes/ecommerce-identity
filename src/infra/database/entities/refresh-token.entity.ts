import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Persistence shape of a refresh token (`refresh_tokens` table). Holds only the SHA-256 hash of
 * the opaque value. Separate from the `RefreshToken` aggregate and mapped explicitly by
 * `RefreshTokenRepository`. Constraints and indexes are created by the migration.
 */
@Entity('refresh_tokens')
export class RefreshTokenEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** Owner (`users.id`, deleted with the user). */
  @Index('IDX_refresh_tokens_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  /** Rotation family. */
  @Index('IDX_refresh_tokens_family_id')
  @Column({ type: 'uuid' })
  familyId!: string;

  /** SHA-256 hex digest of the token value; unique. Never the value itself. */
  @Column({ type: 'char', length: 64, unique: true })
  tokenHash!: string;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  /** Successor token id after rotation. */
  @Column({ type: 'uuid', nullable: true })
  replacedBy!: string | null;
}
