import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Job, JobSchema } from './job.schema';
import { JobController } from './job.controller';
import { JobService } from './job.service';
import { ShelfModule } from '../shelf/shelf.module';
import { RobotModule } from '../robot/robot.module';

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
