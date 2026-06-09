import { forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { EventsGateway } from '../../gateway/events-gateway';
import { RobotGateway } from '../robot/robot.gateway';
import { SlotStatus } from '../shelf/schemas/shelf-slot.schema';
import { ShelfService } from '../shelf/shelf-service';
import { DispatchMoveDto } from './dto/dispatch-move.dto';
import { Job, JobDocument, JobStatus } from './job.schema';

@Injectable()
export class JobService {
  private readonly logger = new Logger(JobService.name);

  constructor(
    @InjectModel(Job.name) private jobModel: Model<JobDocument>,
    private shelfService: ShelfService,
    @Inject(forwardRef(() => RobotGateway))
    private robotGateway: RobotGateway,
    private eventsGateway: EventsGateway,
  ) {}

  async dispatchMove(dto: DispatchMoveDto): Promise<{ jobId: string }> {
    const fromSlot = await this.shelfService.findSlotByCode(dto.fromSlotCode);
    if (!fromSlot) throw new NotFoundException(`Không tìm thấy vị trí "${dto.fromSlotCode}"`);
    if (fromSlot.status === SlotStatus.AVAILABLE || !fromSlot.packageId)
      throw new NotFoundException(`Vị trí "${dto.fromSlotCode}" không có hàng hóa`);

    const toSlot = await this.shelfService.findSlotByCode(dto.toSlotCode);
    if (!toSlot) throw new NotFoundException(`Không tìm thấy vị trí đích "${dto.toSlotCode}"`);
    if (toSlot.status === SlotStatus.OCCUPIED)
      throw new NotFoundException(`Vị trí đích "${dto.toSlotCode}" đã có hàng hóa`);

    const packageId = fromSlot.packageId;

    // Reserve both slots
    await this.shelfService.updateSlotStatus(dto.fromSlotCode, SlotStatus.RESERVED);
    await this.shelfService.updateSlotStatus(dto.toSlotCode, SlotStatus.RESERVED);

    // Create job
    const job = await this.jobModel.create({
      packageId,
      fromSlotCode: dto.fromSlotCode,
      toSlotCode: dto.toSlotCode,
    });

    // Emit to brain
    this.robotGateway.dispatchJob(job);

    // Emit to web clients
    this.eventsGateway.emitJobCreated(job);

    this.logger.log(`Job ${job._id} dispatched: ${dto.fromSlotCode} → ${dto.toSlotCode}`);

    return { jobId: job._id };
  }

  async findAll(): Promise<Job[]> {
    return this.jobModel.find().sort({ createdAt: -1 }).lean();
  }

  async findById(id: string): Promise<Job | null> {
    return this.jobModel.findById(id).lean();
  }

  async updateStatus(jobId: string, status: JobStatus): Promise<void> {
    await this.jobModel.findByIdAndUpdate(jobId, { status });
    const job = await this.jobModel.findById(jobId);
    if (job) {
      this.eventsGateway.emitJobUpdated(job);

      if (status === JobStatus.COMPLETED || status === JobStatus.FAILED) {
        await this.shelfService.updateSlotStatus(job.fromSlotCode, SlotStatus.AVAILABLE);

        if (status === JobStatus.COMPLETED) {
          await this.shelfService.assignPackageToSlot(job.toSlotCode, job.packageId);
        } else {
          await this.shelfService.updateSlotStatus(job.toSlotCode, SlotStatus.AVAILABLE);
        }
      }
    }
  }
}
