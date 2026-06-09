import { forwardRef,Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { RobotModule } from '../robot/robot.module';
import { ShelfModule } from '../shelf/shelf.module';
import { JobController } from './job.controller';
import { Job, JobSchema } from './job.schema';
import { JobService } from './job.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Job.name, schema: JobSchema }]),
    forwardRef(() => ShelfModule),
    forwardRef(() => RobotModule),
  ],
  controllers: [JobController],
  providers: [JobService],
  exports: [JobService],
})
export class JobModule {}
