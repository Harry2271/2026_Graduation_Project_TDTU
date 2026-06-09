import { Module, forwardRef } from '@nestjs/common';
import { RobotGateway } from './robot.gateway';
import { RobotService } from './robot.service';
import { JobModule } from '../job/job.module';

@Module({
  imports: [forwardRef(() => JobModule)],
  providers: [RobotGateway, RobotService],
  exports: [RobotGateway, RobotService],
})
export class RobotModule {}
