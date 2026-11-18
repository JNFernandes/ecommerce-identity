import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { RefreshToken } from '../domain/refresh-token.aggregate';
import { User } from '../domain/user.aggregate';
import { RefreshTokenEntity } from '../infra/database/entities/refresh-token.entity';
import { UserEntity } from '../infra/database/entities/user.entity';
import { UserRepository } from './user.repository';

/**
 * Persistence operations available inside one refresh token transaction (see
 * {@link RefreshTokenRepository.inTransaction}).
 *
 * Lock order: always `findByHash` → `lockFamily` → `findByHashForUpdate`. Every writer of a family
 * takes the family lock before any row lock, so a rotation, a reuse revocation and a logout of the
 * same family can never deadlock.
 */
export interface RefreshTokenTx {
  /**
   * Reads a token by its SHA-256 hash without locking it; used only to learn its family.
   *
   * @param tokenHash SHA-256 hash of the presented value.
   * @returns The token, or `null` when no token has this hash.
   */
  findByHash(tokenHash: string): Promise<RefreshToken | null>;

  /**
   * Reads a token by its SHA-256 hash and locks its row (`SELECT … FOR UPDATE`) until the
   * transaction ends. Call after {@link RefreshTokenTx.lockFamily}.
   *
   * @param tokenHash SHA-256 hash of the presented value.
   * @returns The token as committed, or `null` when no token has this hash.
   */
  findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null>;

  /**
   * Takes the transaction-scoped advisory lock of a family, serializing every rotation and
   * revocation of that family. Released on commit or rollback.
   *
   * @param familyId The family id.
   */
  lockFamily(familyId: string): Promise<void>;

  /**
   * Reads a user with the transaction's connection.
   *
   * @param userId The user id.
   * @returns The user, or `null` when it does not exist.
   */
  findUserById(userId: string): Promise<User | null>;

  /**
   * Returns the session start of a family: the creation time of its first token (the login).
   *
   * @param familyId The family id.
   * @returns The earliest `createdAt`, or `null` when the family has no token.
   */
  familyStartedAt(familyId: string): Promise<Date | null>;

  /**
   * Revokes every not-yet-revoked token of a family. Already revoked rows keep their
   * `revokedAt` and `replacedBy`.
   *
   * @param familyId The family id.
   * @param at The revocation time.
   * @returns The number of tokens revoked.
   */
  revokeFamily(familyId: string, at: Date): Promise<number>;

  /**
   * Stores a rotation: inserts the successor and writes the rotated token's `revokedAt` and
   * `replacedBy`.
   *
   * @param rotated The presented token, after `rotate`.
   * @param next The successor issued in the same family.
   */
  saveRotation(rotated: RefreshToken, next: RefreshToken): Promise<void>;
}

/** {@link RefreshTokenTx} bound to one TypeORM transaction manager. */
class EntityManagerRefreshTokenTx implements RefreshTokenTx {
  constructor(private readonly manager: EntityManager) {}

  async findByHash(tokenHash: string): Promise<RefreshToken | null> {
    const entity = await this.manager.findOne(RefreshTokenEntity, { where: { tokenHash } });
    return entity === null ? null : RefreshTokenRepository.toDomain(entity);
  }

  async findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null> {
    const entity = await this.manager.findOne(RefreshTokenEntity, {
      where: { tokenHash },
      lock: { mode: 'pessimistic_write' },
    });
    return entity === null ? null : RefreshTokenRepository.toDomain(entity);
  }

  async lockFamily(familyId: string): Promise<void> {
    await this.manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
      familyId,
    ]);
  }

  async findUserById(userId: string): Promise<User | null> {
    const entity = await this.manager.findOne(UserEntity, { where: { id: userId } });
    return entity === null ? null : UserRepository.toDomain(entity);
  }

  async familyStartedAt(familyId: string): Promise<Date | null> {
    const row = await this.manager
      .createQueryBuilder(RefreshTokenEntity, 'token')
      .select('MIN(token.createdAt)', 'startedAt')
      .where('token.familyId = :familyId', { familyId })
      .getRawOne<{ startedAt: Date | null }>();
    return row?.startedAt ?? null;
  }

  async revokeFamily(familyId: string, at: Date): Promise<number> {
    const result = await this.manager.update(
      RefreshTokenEntity,
      { familyId, revokedAt: IsNull() },
      { revokedAt: at },
    );
    return result.affected ?? 0;
  }

  async saveRotation(rotated: RefreshToken, next: RefreshToken): Promise<void> {
    await this.manager.insert(RefreshTokenEntity, RefreshTokenRepository.toEntity(next));
    await this.manager.update(
      RefreshTokenEntity,
      { id: rotated.id },
      { revokedAt: rotated.revokedAt, replacedBy: rotated.replacedBy },
    );
  }
}

/**
 * Persists `RefreshToken` aggregates in the `refresh_tokens` table. Maps explicitly between the
 * aggregate and `RefreshTokenEntity`; holds no business rules.
 */
@Injectable()
export class RefreshTokenRepository {
  /** @param dataSource The TypeORM data source, used for the login and refresh transactions. */
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Stores a newly issued token and the user's `lastLoginAt` in one transaction: either both are
   * committed or neither is. Only the `lastLoginAt` column of the user is written.
   *
   * @param token The issued token (holds the hash, never the value).
   * @param user The user who logged in, after `recordLogin`.
   */
  async saveWithLogin(token: RefreshToken, user: User): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.update(UserEntity, { id: user.id }, { lastLoginAt: user.lastLoginAt });
      await manager.insert(RefreshTokenEntity, RefreshTokenRepository.toEntity(token));
    });
  }

  /**
   * Runs `work` in one database transaction (READ COMMITTED). Everything `work` does through the
   * given {@link RefreshTokenTx} commits when it resolves and rolls back when it rejects.
   *
   * @param work The unit of work; its result is returned after the commit.
   * @returns What `work` resolved to.
   */
  async inTransaction<T>(work: (tx: RefreshTokenTx) => Promise<T>): Promise<T> {
    return this.dataSource.transaction((manager) => work(new EntityManagerRefreshTokenTx(manager)));
  }

  /**
   * Maps a stored row to the aggregate.
   *
   * @param entity The stored row.
   */
  static toDomain(entity: RefreshTokenEntity): RefreshToken {
    return RefreshToken.restore({
      id: entity.id,
      userId: entity.userId,
      familyId: entity.familyId,
      tokenHash: entity.tokenHash,
      createdAt: entity.createdAt,
      expiresAt: entity.expiresAt,
      revokedAt: entity.revokedAt,
      replacedBy: entity.replacedBy,
    });
  }

  /**
   * Maps the aggregate to a row.
   *
   * @param token The aggregate.
   */
  static toEntity(token: RefreshToken): RefreshTokenEntity {
    const entity = new RefreshTokenEntity();
    entity.id = token.id;
    entity.userId = token.userId;
    entity.familyId = token.familyId;
    entity.tokenHash = token.tokenHash;
    entity.createdAt = token.createdAt;
    entity.expiresAt = token.expiresAt;
    entity.revokedAt = token.revokedAt;
    entity.replacedBy = token.replacedBy;
    return entity;
  }
}
