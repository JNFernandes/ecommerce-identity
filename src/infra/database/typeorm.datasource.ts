import 'dotenv/config';
import { DataSource } from 'typeorm';
import configuration from '../../config/configuration';
import { ENTITIES_GLOB, buildDataSourceOptions } from './typeorm-options';

/**
 * Data source for the TypeORM CLI (`npm run migration:run`, `npm run migration:revert`). It reads
 * the same `DATABASE_*` variables as the application (from the environment or `.env`).
 */
export default new DataSource({
  ...buildDataSourceOptions(configuration().database),
  entities: [ENTITIES_GLOB],
});
