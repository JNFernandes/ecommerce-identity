import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Path of the Swagger UI; the OpenAPI document is served at `/docs-json`. */
export const SWAGGER_PATH = 'docs';

/** Shape of an operation as far as {@link annotateAccess} reads and writes it. */
interface AccessAnnotatedOperation {
  description?: string;
  'x-roles'?: unknown;
  'x-public'?: boolean;
}

/**
 * States every operation's access requirement at the top of its description, so the Swagger UI
 * shows it without vendor extensions. Operations from `@Roles(...)` carry `x-roles`; every other
 * operation is `@Public()` (the startup route-policy check guarantees one of the two) and is marked
 * `x-public: true`. Documentation only: nothing here changes what the guards enforce.
 *
 * @param document The generated OpenAPI document, changed in place.
 * @returns The same document.
 */
export function annotateAccess(document: OpenAPIObject): OpenAPIObject {
  for (const pathItem of Object.values(document.paths)) {
    for (const value of Object.values(pathItem as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || !('responses' in value)) {
        continue;
      }
      const operation = value as AccessAnnotatedOperation;
      const roles = operation['x-roles'];
      let access: string;
      if (Array.isArray(roles) && roles.length > 0) {
        access = `**Roles:** ${roles.join(', ')} (bearer access token required).`;
      } else {
        operation['x-public'] = true;
        access = '**Access:** public (no token; any `Authorization` header is ignored).';
      }
      operation.description = operation.description
        ? `${access}\n\n${operation.description}`
        : access;
    }
  }
  return document;
}

/** Serves the OpenAPI document generated from the NestJS decorators at `/docs`. */
export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('ecommerce-identity')
    .setDescription(
      'Identity microservice — users, credentials and sessions; issues JWTs. Every route is denied ' +
        'by default: each operation states its access (`x-public` or `x-roles`) at the top of its ' +
        'description.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = annotateAccess(SwaggerModule.createDocument(app, config));
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: { showExtensions: true },
  });
}
