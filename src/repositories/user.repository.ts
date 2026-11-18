import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Email } from '../domain/email.value-object';
import { DuplicateEmailError } from '../domain/errors/duplicate-email.error';
import { Role } from '../domain/role.enum';
import { User } from '../domain/user.aggregate';
import { UserName } from '../domain/user-name.value-object';
import { UserEntity } from '../infra/database/entities/user.entity';
import { ListUsersQuery } from '../queries/list-users.query';
import { UserPageReadModel, UserSummaryReadModel } from '../queries/user-summary.read-model';
import { isUniqueViolation } from './errors/is-unique-violation';

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

  private static toEntity(user: User): UserEntity {
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
