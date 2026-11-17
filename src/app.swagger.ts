import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Path of the Swagger UI; the OpenAPI document is served at `/docs-json`. */
export const SWAGGER_PATH = 'docs';

/** Serves the OpenAPI document generated from the NestJS decorators at `/docs`. */
export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('ecommerce-identity')
    .setDescription('Identity microservice — users, credentials and sessions; issues JWTs')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(SWAGGER_PATH, app, SwaggerModule.createDocument(app, config));
}
