import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { AuditRecord } from '../domain/audit/audit-record';
import { Email } from '../domain/email.value-object';
import { DuplicateEmailError } from '../domain/errors/duplicate-email.error';
import { Role } from '../domain/role.enum';
import { User } from '../domain/user.aggregate';
import { UserName } from '../domain/user-name.value-object';
import { UserStatus } from '../domain/user-status.enum';
import { RefreshTokenEntity } from '../infra/database/entities/refresh-token.entity';
import { UserEntity } from '../infra/database/entities/user.entity';
import { ListUsersQuery } from '../queries/list-users.query';
import { UserPageReadModel, UserSummaryReadModel } from '../queries/user-summary.read-model';
import { isUniqueViolation } from './errors/is-unique-violation';

/**
 * Key of the transaction-scoped advisory lock that serializes every admin mutation (status
 * changes, user creation), as the two 32-bit integers of `pg_advisory_xact_lock(int, int)`. That
 * key space never overlaps the 64-bit keys of the refresh token family locks.
 */
export const ADMIN_CHANGES_LOCK_KEY: readonly [number, number] = [0x1d_57a7, 1];

/**
 * Persistence operations available inside one admin transaction (see
 * {@link UserRepository.inAdminTransaction}).
 *
 * Lock order: always `lockAdminChanges` → `findById` (acting admin, no lock) →
 * `findByIdForUpdate` (target row) → writes → `appendAudit` (last, so the record describes what
 * was written). The advisory lock is taken before any row lock, so
 * two admin mutations never wait on each other's rows and cannot deadlock.
 */
export interface AdminTx {
  /**
   * Takes the transaction-scoped advisory lock that serializes every admin mutation. Released on
   * commit or rollback.
   */
  lockAdminChanges(): Promise<void>;

  /**
   * Reads a user without locking it.
   *
   * @param id The user id.
   * @returns The user, or `null` when none has this id.
   */
  findById(id: string): Promise<User | null>;

  /**
   * Reads a user and locks its row (`SELECT … FOR UPDATE`) until the transaction ends.
   *
   * @param id The user id.
   * @returns The user as committed, or `null` when none has this id.
   */
  findByIdForUpdate(id: string): Promise<User | null>;

  /** Counts the users that are `ACTIVE` and hold the `ADMIN` role. */
  countActiveAdmins(): Promise<number>;

  /**
   * Writes the user's `status` and `updatedAt`; no other column is touched.
   *
   * @param user The user, after `disable` or `enable`.
   */
  saveStatus(user: User): Promise<void>;

  /**
   * Revokes every not-yet-revoked refresh token of a user, in every family. Already revoked rows
   * keep their `revokedAt` and `replacedBy`.
   *
   * @param userId The user id.
   * @param at The revocation time.
   * @returns The number of tokens revoked.
   */
  revokeAllRefreshTokens(userId: string, at: Date): Promise<number>;

  /**
   * Inserts a new user. A unique violation (email taken, case-insensitive) aborts the transaction.
   *
   * @param user The new user.
   * @throws DuplicateEmailError When another user already has the email.
   */
  insertUser(user: User): Promise<void>;

  /**
   * Appends one audit record (insert only; the table rejects updates and deletes).
   *
   * @param record The record of the change made in this transaction.
   */
  appendAudit(record: AuditRecord): Promise<void>;
}

/** {@link AdminTx} bound to one TypeORM transaction manager. */
class EntityManagerAdminTx implements AdminTx {
  constructor(private readonly manager: EntityManager) {}

  async lockAdminChanges(): Promise<void> {
    await this.manager.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [
      ...ADMIN_CHANGES_LOCK_KEY,
    ]);
  }

  async findById(id: string): Promise<User | null> {
    const entity = await this.manager.findOne(UserEntity, { where: { id } });
    return entity === null ? null : UserRepository.toDomain(entity);
  }

  async findByIdForUpdate(id: string): Promise<User | null> {
    const entity = await this.manager.findOne(UserEntity, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    return entity === null ? null : UserRepository.toDomain(entity);
  }

  async countActiveAdmins(): Promise<number> {
    return this.manager
      .createQueryBuilder(UserEntity, 'user')
      .where('user.status = :status', { status: UserStatus.ACTIVE })
      .andWhere(':role::user_role_enum = ANY(user.roles)', { role: Role.ADMIN })
      .getCount();
  }

  async saveStatus(user: User): Promise<void> {
    await this.manager.update(
      UserEntity,
      { id: user.id },
      { status: user.status, updatedAt: user.updatedAt },
    );
  }

  async revokeAllRefreshTokens(userId: string, at: Date): Promise<number> {
    const result = await this.manager.update(
      RefreshTokenEntity,
      { userId, revokedAt: IsNull() },
      { revokedAt: at },
    );
    return result.affected ?? 0;
  }

  async insertUser(user: User): Promise<void> {
    try {
      await this.manager.insert(UserEntity, UserRepository.toEntity(user));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateEmailError();
      }
      throw error;
    }
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    // A plain INSERT: the table is append-only, so nothing here may ever update a row.
    await this.manager.query(
      `INSERT INTO "audit_records" ("id", "actorId", "action", "targetId", "before", "after", "occurredAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [
        record.id,
        record.actorId,
        record.action,
        record.targetId,
        record.before === null ? null : JSON.stringify(record.before),
        JSON.stringify(record.after),
        record.occurredAt,
      ],
    );
  }
}

/**
 * Persists `User` aggregates in the `users` table. Maps explicitly between the aggregate and
 * `UserEntity`; holds no business rules.
 */
@Injectable()
export class UserRepository {
  /** @param repository TypeORM repository of `UserEntity`. */
  constructor(
    @InjectRepository(UserEntity)
    private readonly repository: Repository<UserEntity>,
  ) {}

  /**
   * Saves a user and commits it.
   *
   * @param user The user to store.
   * @throws DuplicateEmailError When another user already has the email (case-insensitive).
   */
  async save(user: User): Promise<void> {
    try {
      await this.repository.save(UserRepository.toEntity(user));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateEmailError();
      }
      throw error;
    }
  }

  /**
   * Loads a user by id.
   *
   * @param id The user id.
   * @returns The user, or `null` when none exists.
   */
  async findById(id: string): Promise<User | null> {
    const entity = await this.repository.findOneBy({ id });
    return entity === null ? null : UserRepository.toDomain(entity);
  }

  /**
   * Loads a user by email, compared on `lower(email)` (the unique index).
   *
   * @param normalized The normalized email (see `Email.normalize`).
   * @returns The user, or `null` when none exists.
   */
  async findByEmail(normalized: string): Promise<User | null> {
    const entity = await this.repository
      .createQueryBuilder('user')
      .where('lower(user.email) = :email', { email: normalized })
      .getOne();
    return entity === null ? null : UserRepository.toDomain(entity);
  }

  /**
   * Tells whether any user holds the role, whatever its status.
   *
   * @param role The role to look for.
   */
  async existsWithRole(role: Role): Promise<boolean> {
    const row = await this.repository
      .createQueryBuilder('user')
      .select('1')
      .where(':role::user_role_enum = ANY(user.roles)', { role })
      .limit(1)
      .getRawOne<unknown>();
    return row !== undefined && row !== null;
  }

  /**
   * Runs `work` in one database transaction (READ COMMITTED). Everything `work` does through the
   * given {@link AdminTx} commits when it resolves and rolls back when it rejects. Callers
   * take the locks in the order documented on {@link AdminTx}.
   *
   * @param work The unit of work; its result is returned after the commit.
   * @returns What `work` resolved to.
   */
  async inAdminTransaction<T>(work: (tx: AdminTx) => Promise<T>): Promise<T> {
    return this.repository.manager.transaction((manager) =>
      work(new EntityManagerAdminTx(manager)),
    );
  }

  /**
   * Reads one page of users matching every given filter (AND), newest first: `createdAt`
   * descending, then `id` descending so equal creation times keep a stable order across pages.
   *
   * @param query Page size, offset and optional role, status and email prefix filters. The email
   * prefix is compared case-insensitively and literally (`\`, `%` and `_` are escaped).
   * @returns The page and the number of users matching the filters, ignoring paging.
   */
  async findPage(query: ListUsersQuery): Promise<UserPageReadModel> {
    const builder = this.repository.createQueryBuilder('user');
    if (query.role !== undefined) {
      builder.andWhere(':role::user_role_enum = ANY(user.roles)', { role: query.role });
    }
    if (query.status !== undefined) {
      builder.andWhere('user.status = :status', { status: query.status });
    }
    if (query.emailPrefix !== undefined) {
      builder.andWhere(`lower(user.email) LIKE :prefix ESCAPE '\\'`, {
        prefix: `${escapeLike(query.emailPrefix.toLowerCase())}%`,
      });
    }
    const [entities, total] = await builder
      .orderBy('user.createdAt', 'DESC')
      .addOrderBy('user.id', 'DESC')
      .offset(query.offset)
      .limit(query.limit)
      .getManyAndCount();
    return {
      items: entities.map((entity) => UserRepository.toSummary(entity)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Reads one user as the admin read model (same shape as a `findPage` item).
   *
   * @param id The user id.
   * @returns The user, or `null` when none has this id.
   */
  async findSummaryById(id: string): Promise<UserSummaryReadModel | null> {
    const entity = await this.repository.findOneBy({ id });
    return entity === null ? null : UserRepository.toSummary(entity);
  }

  /** Maps a stored row to the admin read model; the hash and `updatedAt` are left out. */
  private static toSummary(entity: UserEntity): UserSummaryReadModel {
    return {
      id: entity.id,
      customerId: entity.customerId,
      email: entity.email,
      name: entity.name,
      roles: [...entity.roles],
      status: entity.status,
      createdAt: entity.createdAt,
      lastLoginAt: entity.lastLoginAt,
    };
  }

  /**
   * Maps the aggregate to its row. Public so the admin transaction inserts users with the same
   * mapping as {@link UserRepository.save}.
   *
   * @param user The aggregate.
   */
  static toEntity(user: User): UserEntity {
    const entity = new UserEntity();
    entity.id = user.id;
    entity.customerId = user.customerId;
    entity.email = user.email.value;
    entity.name = user.name.value;
    entity.passwordHash = user.passwordHash;
    entity.roles = user.roles;
    entity.status = user.status;
    entity.createdAt = user.createdAt;
    entity.updatedAt = user.updatedAt;
    entity.lastLoginAt = user.lastLoginAt;
    return entity;
  }

  /**
   * Maps a stored user row to the domain aggregate. Public so other repositories that read users
   * inside their own transaction (e.g. the refresh token transaction) share the same mapping.
   *
   * @param entity The stored row.
   */
  static toDomain(entity: UserEntity): User {
    return User.restore({
      id: entity.id,
      customerId: entity.customerId,
      email: Email.create(entity.email),
      name: UserName.create(entity.name),
      passwordHash: entity.passwordHash,
      roles: entity.roles,
      status: entity.status,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      lastLoginAt: entity.lastLoginAt,
    });
  }
}

/** Escapes the `LIKE` wildcards `%` and `_` and the escape character `\` itself. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
