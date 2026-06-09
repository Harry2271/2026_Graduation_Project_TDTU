import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseConfig } from './config/database.config';
import { GatewayModule } from './gateway/gateway.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { JobModule } from './modules/job/job.module';
import { MapsModule } from './modules/maps/maps.module';
import { PackageModule } from './modules/package/package.module';
import { RobotModule } from './modules/robot/robot.module';
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
    AuthModule,
    JobModule,
    RobotModule,
    MapsModule,
    PackageModule,
    ShelfModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
