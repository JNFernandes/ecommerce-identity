import { Injectable, OnApplicationBootstrap, RequestMethod, Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Role } from '../../domain/role.enum';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

/** Joins route path segments into `/a/b`, dropping empty segments and duplicate slashes. */
function joinPath(...segments: unknown[]): string {
  const parts = segments
    .flatMap((segment) => (Array.isArray(segment) ? segment : [segment]))
    .filter((segment): segment is string => typeof segment === 'string')
    .flatMap((segment) => segment.split('/'))
    .filter((part) => part.length > 0);
  return `/${parts.join('/')}`;
}

/**
 * Lists every route handler whose access policy is not exactly one of `@Public()` or a non-empty
 * `@Roles(...)` (on the handler or its controller).
 *
 * @param controllers The controller classes to check.
 * @param reflector Reads the policy metadata.
 * @param metadataScanner Lists the methods of each controller.
 * @returns One `<Controller>.<handler> (<METHOD> <path>)` entry per violation; empty when valid.
 */
export function findRoutePolicyViolations(
  controllers: readonly Type[],
  reflector: Reflector,
  metadataScanner: MetadataScanner,
): string[] {
  const violations: string[] = [];
  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of metadataScanner.getAllMethodNames(prototype)) {
      const handler = prototype[name];
      if (typeof handler !== 'function') {
        continue;
      }
      const routePath: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      if (routePath === undefined) {
        continue;
      }
      const targets = [handler, controller];
      const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets);
      const roles = reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
      const declaresPublic = isPublic === true;
      const valid = declaresPublic ? roles === undefined : roles !== undefined && roles.length > 0;
      if (!valid) {
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        const verb = RequestMethod[method ?? RequestMethod.GET];
        const path = joinPath(Reflect.getMetadata(PATH_METADATA, controller), routePath);
        violations.push(`${controller.name}.${name} (${verb} ${path})`);
      }
    }
  }
  return violations;
}

/**
 * Fails startup when any route lacks an access policy (default deny made visible). Runs in
 * `onApplicationBootstrap`, which `app.listen()` awaits before serving a request.
 */
@Injectable()
export class RoutePolicyCheck implements OnApplicationBootstrap {
  /**
   * @param discovery Lists the registered controllers.
   * @param reflector Reads the policy metadata.
   * @param metadataScanner Lists controller methods.
   */
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly metadataScanner: MetadataScanner,
  ) {}

  /**
   * Checks every registered controller.
   *
   * @throws Error `route policy violation: <Controller>.<handler> (<METHOD> <path>), …`
   */
  onApplicationBootstrap(): void {
    const controllers = this.discovery
      .getControllers()
      .map((wrapper) => wrapper.metatype)
      .filter((metatype): metatype is Type => typeof metatype === 'function');
    const violations = findRoutePolicyViolations(controllers, this.reflector, this.metadataScanner);
    if (violations.length > 0) {
      throw new Error(`route policy violation: ${violations.join(', ')}`);
    }
  }
}
