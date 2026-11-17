import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../domain/refresh-token.aggregate';
import { User } from '../domain/user.aggregate';
import { RefreshTokenEntity } from '../infra/database/entities/refresh-token.entity';
import { UserEntity } from '../infra/database/entities/user.entity';

/**
 * Persists `RefreshToken` aggregates in the `refresh_tokens` table. Maps explicitly between the
 * aggregate and `RefreshTokenEntity`; holds no business rules.
 */
@Injectable()
export class RefreshTokenRepository {
  /** @param dataSource The TypeORM data source, used for the login transaction. */
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

  private static toEntity(token: RefreshToken): RefreshTokenEntity {
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
