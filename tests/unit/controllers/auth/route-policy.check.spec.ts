import { Controller, Get, Post, Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../../src/app.module';
import { Public } from '../../../../src/controllers/auth/public.decorator';
import { Roles } from '../../../../src/controllers/auth/roles.decorator';
import {
  findRoutePolicyViolations,
  RoutePolicyCheck,
} from '../../../../src/controllers/auth/route-policy.check';
import { Role } from '../../../../src/domain/role.enum';

@Controller('things')
class UndeclaredController {
  @Get(':id')
  find(): void {}
}

@Controller('mixed')
class MixedController {
  @Get()
  @Public()
  @Roles(Role.ADMIN)
  both(): void {}

  @Post('empty')
  @Roles()
  empty(): void {}

  @Get('ok')
  @Roles(Role.CUSTOMER)
  ok(): void {}

  helper(): void {}
}

@Public()
@Controller()
class PublicController {
  @Get()
  root(): void {}
}

@Roles(Role.ADMIN)
@Controller('admin')
class AdminController {
  @Get()
  list(): void {}
}

describe('route policy check', () => {
  const reflector = new Reflector();
  const scanner = new MetadataScanner();
  const check = (controllers: Type[]): string[] =>
    findRoutePolicyViolations(controllers, reflector, scanner);

  it('should find no violation in any AppModule controller', () => {
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) as Type[];

    expect(controllers.length).toBeGreaterThan(0);
    expect(check(controllers)).toEqual([]);
  });

  it('should accept class-level @Public and @Roles', () => {
    expect(check([PublicController, AdminController])).toEqual([]);
  });

  it('should name an undeclared handler with its method and path', () => {
    expect(check([UndeclaredController])).toEqual(['UndeclaredController.find (GET /things/:id)']);
  });

  it('should name handlers with both decorators or empty roles, skipping non-routes', () => {
    expect(check([MixedController])).toEqual([
      'MixedController.both (GET /mixed)',
      'MixedController.empty (POST /mixed/empty)',
    ]);
  });

  it('should make init() reject with the undeclared route in the message', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [UndeclaredController, AdminController],
      providers: [RoutePolicyCheck],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });

    await expect(app.init()).rejects.toThrow(
      'route policy violation: UndeclaredController.find (GET /things/:id)',
    );
    await app.close();
  });
});
