import { CommandBus } from '@nestjs/cqrs';
import { RegisterCustomerCommand } from '../../../src/commands/register-customer.command';
import { AuthController } from '../../../src/controllers/auth.controller';
import { Email } from '../../../src/domain/email.value-object';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { RegisterDto } from '../../../src/dto/register.dto';
import { RegisterResponseDto } from '../../../src/dto/register-response.dto';

describe('AuthController', () => {
  const body: RegisterDto = { email: 'Ana@Example.com ', name: 'Ana', password: 'correct-horse' };
  let execute: jest.Mock<Promise<unknown>, [unknown]>;
  let controller: AuthController;

  beforeEach(() => {
    execute = jest.fn<Promise<unknown>, [unknown]>();
    controller = new AuthController({ execute } as unknown as CommandBus);
  });

  it('should dispatch a RegisterCustomerCommand built from the body', async () => {
    execute.mockResolvedValue(
      User.registerCustomer(Email.create(body.email), UserName.create(body.name), 'hash'),
    );

    await controller.register(body);

    expect(execute).toHaveBeenCalledWith(
      new RegisterCustomerCommand(body.email, body.name, body.password),
    );
  });

  it('should return the mapped response DTO', async () => {
    const user = User.registerCustomer(Email.create(body.email), UserName.create('Ana'), 'hash');
    execute.mockResolvedValue(user);

    await expect(controller.register(body)).resolves.toEqual(RegisterResponseDto.fromUser(user));
  });
});
