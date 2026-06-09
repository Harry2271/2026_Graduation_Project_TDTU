import { Controller, Get, Param, Post, Body } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JobService } from './job.service';
import { DispatchMoveDto } from './dto/dispatch-move.dto';

@ApiTags('Jobs')
@Controller('jobs')
export class JobController {
  constructor(private jobService: JobService) {}

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

  @Get(':id')
  @ApiOperation({ summary: 'Get job by ID' })
  @ApiOkResponse({ description: 'Single job' })
  async findById(@Param('id') id: string) {
    return this.jobService.findById(id);
  }
}
