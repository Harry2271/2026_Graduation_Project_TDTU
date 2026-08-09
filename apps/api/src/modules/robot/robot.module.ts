import { forwardRef, Module } from '@nestjs/common';

import { GatewayModule } from '../../gateway/gateway.module';
import { JobModule } from '../job/job.module';
import { ShelfModule } from '../shelf/shelf.module';
import { RobotGateway } from './robot.gateway';
import { RobotService } from './robot.service';

@Module({
  imports: [
    GatewayModule,
    forwardRef(() => JobModule),
    forwardRef(() => ShelfModule),
  ],
  providers: [RobotGateway, RobotService],
  exports: [RobotGateway, RobotService],
})
export class RobotModule {}
