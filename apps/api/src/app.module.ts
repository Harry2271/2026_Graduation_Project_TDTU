import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseConfig } from './config/database.config';
import { GatewayModule } from './gateway/gateway.module';
import { MapsModule } from './modules/maps/maps.module';
import { PackageModule } from './modules/package/package.module';
import { ShelfModule } from './modules/shelf/shelf.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    TerminusModule,
    HttpModule,
    DatabaseConfig,
    GatewayModule,
    MapsModule,
    PackageModule,
    ShelfModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
