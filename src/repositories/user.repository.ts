import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Email } from '../domain/email.value-object';
import { DuplicateEmailError } from '../domain/errors/duplicate-email.error';
import { User } from '../domain/user.aggregate';
import { UserName } from '../domain/user-name.value-object';
import { UserEntity } from '../infra/database/entities/user.entity';
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
    return entity;
  }

  private static toDomain(entity: UserEntity): User {
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
    });
  }
}
