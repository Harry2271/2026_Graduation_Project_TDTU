import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseConfig } from './config/database.config';
import { PackageModule } from './modules/package/package.module';
import { ShelfModule } from './modules/shelf/shelf.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    CacheModule.register({
      isGlobal: true,
      ttl: 300 * 1000,
      max: 100,
    }),
    TerminusModule,
    HttpModule,
    DatabaseConfig,
    PackageModule,
    ShelfModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
