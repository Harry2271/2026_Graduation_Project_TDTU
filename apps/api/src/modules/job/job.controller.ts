import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { DispatchMoveDto } from './dto/dispatch-move.dto';
import { JobService } from './job.service';
import { RobotService } from '../robot/robot.service';

@ApiTags('Jobs')
@Controller('jobs')
export class JobController {
  constructor(
    private jobService: JobService,
    private robotService: RobotService,
  ) {}

  @Post('dispatch')
  @ApiOperation({ summary: 'Dispatch a move job for the AGV robot' })
  @ApiCreatedResponse({ description: 'Job dispatched, returns jobId' })
  async dispatch(@Body() dto: DispatchMoveDto) {
    return this.jobService.dispatchMove(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all jobs' })
  @ApiOkResponse({ description: 'Array of jobs' })
  async findAll() {
    return this.jobService.findAll();
  }

  @Get('queue')
  @ApiOperation({ summary: 'List queued jobs (waiting for brain)' })
  @ApiOkResponse({ description: 'Array of queued jobs' })
  async findQueued() {
    return this.jobService.findAllQueued();
  }

  @Get('health')
  @ApiOperation({ summary: 'Robot brain health snapshot' })
  @ApiOkResponse({ description: 'Health object' })
  getHealth() {
    return this.robotService.getHealth();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get job by ID' })
  @ApiOkResponse({ description: 'Single job' })
  async findById(@Param('id') id: string) {
    return this.jobService.findById(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a queued or active job' })
  @ApiOkResponse({ description: 'Job cancelled' })
  async cancelJob(@Param('id') id: string) {
    await this.jobService.cancelJob(id);
    return { ok: true };
  }

  @Put(':id/timing')
  @ApiOperation({ summary: 'Update delivery timing data for a job' })
  @ApiOkResponse({ description: 'Timing updated' })
  async updateTiming(
    @Param('id') id: string,
    @Body() body: {
      startedAt?: string;
      pickupAt?: string;
      dropoffAt?: string;
      unloadAt?: string;
      totalDurationMs?: number;
      fullCycleDurationMs?: number;
      travelToPickupMs?: number;
      travelToDropoffMs?: number;
      unloadDurationMs?: number;
    },
  ) {
    await this.jobService.updateTiming(id, {
      startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
      pickupAt: body.pickupAt ? new Date(body.pickupAt) : undefined,
      dropoffAt: body.dropoffAt ? new Date(body.dropoffAt) : undefined,
      unloadAt: body.unloadAt ? new Date(body.unloadAt) : undefined,
      totalDurationMs: body.totalDurationMs,
      fullCycleDurationMs: body.fullCycleDurationMs,
      travelToPickupMs: body.travelToPickupMs,
      travelToDropoffMs: body.travelToDropoffMs,
      unloadDurationMs: body.unloadDurationMs,
    });
    return { ok: true };
  }
}
