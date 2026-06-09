import { forwardRef,Module } from '@nestjs/common';

import { JobModule } from '../job/job.module';
import { RobotGateway } from './robot.gateway';
import { RobotService } from './robot.service';

@Module({
  imports: [forwardRef(() => JobModule)],
  providers: [RobotGateway, RobotService],
  exports: [RobotGateway, RobotService],
})
export class RobotModule {}
