import { Email } from '../../../src/domain/email.value-object';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { RegisterResponseDto } from '../../../src/dto/register-response.dto';

describe('RegisterResponseDto.fromUser', () => {
  const user = User.registerCustomer(
    Email.create('ana@example.com'),
    UserName.create('Ana'),
    '$argon2id$secret-hash',
  );

  it('should return exactly the six public fields', () => {
    const dto = RegisterResponseDto.fromUser(user);

    expect(Object.keys(dto).sort()).toEqual(
      ['createdAt', 'customerId', 'email', 'id', 'name', 'roles'].sort(),
    );
  });

  it('should copy the values from the user', () => {
    expect(RegisterResponseDto.fromUser(user)).toEqual({
      id: user.id,
      customerId: user.customerId,
      email: 'ana@example.com',
      name: 'Ana',
      roles: [Role.CUSTOMER],
      createdAt: user.createdAt.toISOString(),
    });
  });

  it('should never expose the password hash', () => {
    expect(JSON.stringify(RegisterResponseDto.fromUser(user))).not.toContain('secret-hash');
  });
});
