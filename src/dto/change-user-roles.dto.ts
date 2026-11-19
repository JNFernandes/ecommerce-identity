import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, ArrayUnique, IsArray, IsEnum } from 'class-validator';
import { Role } from '../domain/role.enum';

/**
 * Body of `PUT /users/{id}/roles`. The list replaces the user's roles. Any other field is rejected
 * by the global validation pipe.
 */
export class ChangeUserRolesDto {
  /** A non-empty list of distinct roles from `CUSTOMER` and `ADMIN`, in any order. */
  @ApiProperty({
    enum: Role,
    isArray: true,
    example: [Role.CUSTOMER, Role.ADMIN],
    description:
      'The roles the user must hold after the request (replaces the current ones): a non-empty ' +
      'list of distinct values from CUSTOMER and ADMIN',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsEnum(Role, { each: true })
  roles!: Role[];
}
