import { forwardRef, Module } from '@nestjs/common';

import { JobModule } from '../job/job.module';
import { ShelfModule } from '../shelf/shelf.module';
import { RobotGateway } from './robot.gateway';
import { RobotService } from './robot.service';

@Module({
  imports: [forwardRef(() => JobModule), forwardRef(() => ShelfModule)],
  providers: [RobotGateway, RobotService],
  exports: [RobotGateway, RobotService],
})
export class RobotModule {}
