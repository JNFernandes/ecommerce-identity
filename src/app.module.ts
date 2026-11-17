import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';

/** Root module of the identity service. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] })],
})
export class AppModule {}
