import { forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { randomUUID } from 'node:crypto';

import { EventsGateway } from '../../gateway/events-gateway';
import { RobotGateway } from '../robot/robot.gateway';
import { RobotService } from '../robot/robot.service';
import { SlotStatus } from '../shelf/schemas/shelf-slot.schema';
import { ShelfService } from '../shelf/shelf-service';
import { DispatchMoveDto } from './dto/dispatch-move.dto';
import { Job, JobDocument, JobPhase, JobStatus } from './job.schema';

@Injectable()
export class JobService {
  private readonly logger = new Logger(JobService.name);

  constructor(
    @InjectModel(Job.name) private jobModel: Model<JobDocument>,
    @InjectConnection() private connection: Connection,
    private shelfService: ShelfService,
    @Inject(forwardRef(() => RobotGateway))
    private robotGateway: RobotGateway,
    @Inject(forwardRef(() => RobotService))
    private robotService: RobotService,
    private eventsGateway: EventsGateway,
  ) {}

  // ── Dispatch (transactional) ─────────────────────────────────────────────

  /**
   * Validate → reserve both slots inside a MongoDB transaction →
   * create job (QUEUED or DISPATCHED) → attempt immediate dispatch.
   *
   * Idempotency: if `operationId` matches an existing non-terminal job
   * that job is returned as-is (no duplicate created).
   */
  async dispatchMove(dto: DispatchMoveDto): Promise<{ jobId: string }> {
    // ── idempotency check ────────────────────────────────────────────────
    if (dto.operationId) {
      const existing = await this.jobModel.findOne({
        operationId: dto.operationId,
        status: { $in: [JobStatus.QUEUED, JobStatus.DISPATCHED, JobStatus.IN_PROGRESS] },
      });
      if (existing) {
        this.logger.warn(`Idempotent hit — returning existing job ${existing._id}`);
        return { jobId: existing._id };
      }
    }

    // ── pre-validation (outside tx — lightweight reads) ───────────────────
    const fromSlot = await this.shelfService.findSlotByCode(dto.fromSlotCode);
    if (!fromSlot) throw new NotFoundException(`Không tìm thấy vị trí "${dto.fromSlotCode}"`);
    if (fromSlot.status === SlotStatus.AVAILABLE || !fromSlot.packageId)
      throw new NotFoundException(`Vị trí "${dto.fromSlotCode}" không có hàng hóa`);

    const toSlot = await this.shelfService.findSlotByCode(dto.toSlotCode);
    if (!toSlot) throw new NotFoundException(`Không tìm thấy vị trí đích "${dto.toSlotCode}"`);
    if (toSlot.status === SlotStatus.OCCUPIED || toSlot.status === SlotStatus.TRANSIT)
      throw new NotFoundException(`Vị trí đích "${dto.toSlotCode}" đã có hàng hóa`);

    const packageId = fromSlot.packageId;

    // ── transaction: reserve slots + create job atomically ────────────────
    const session = await this.connection.startSession();
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });

    try {
      // Re-check slot statuses inside tx snapshot to prevent TOCTOU races.
      const freshFrom = await this.shelfService.findSlotByCode(dto.fromSlotCode, session);
      const freshTo = await this.shelfService.findSlotByCode(dto.toSlotCode, session);
      if (!freshFrom || freshFrom.status !== SlotStatus.OCCUPIED)
        throw new Error('SOURCE_SLOT_NOT_AVAILABLE');
      if (!freshTo || (freshTo.status !== SlotStatus.AVAILABLE && freshTo.status !== SlotStatus.RESERVED))
        throw new Error('DEST_SLOT_NOT_AVAILABLE');

      await this.shelfService.updateSlotStatus(dto.fromSlotCode, SlotStatus.RESERVED, session);
      await this.shelfService.updateSlotStatus(dto.toSlotCode, SlotStatus.RESERVED, session);

      const [job] = await this.jobModel.create([{
        packageId,
        fromSlotCode: dto.fromSlotCode,
        toSlotCode: dto.toSlotCode,
        operationId: dto.operationId ?? randomUUID(),
        status: JobStatus.QUEUED,
        queuedAt: new Date(),
        phase: JobPhase.NONE,
      }], { session });

      await session.commitTransaction();
      this.eventsGateway.emitJobCreated(job);

      // Attempt immediate dispatch (if brain is free and online).
      await this.tryDispatchNext();

      this.logger.log(`Job ${job._id} queued: ${dto.fromSlotCode} → ${dto.toSlotCode}`);
      return { jobId: job._id };
    } catch (err) {
      await session.abortTransaction();
      if (err instanceof Error && (err.message === 'SOURCE_SLOT_NOT_AVAILABLE' || err.message === 'DEST_SLOT_NOT_AVAILABLE')) {
        throw new NotFoundException(`Slot không khả dụng (đã có job khác đang xử lý)`);
      }
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ── Queue processing ────────────────────────────────────────────────────

  /**
   * Called after every job status change.  If brain is online and idle,
   * populates the oldest QUEUED job and dispatches it.
   */
  async tryDispatchNext(): Promise<void> {
    if (!this.robotService.isBrainConnected()) {
      this.logger.debug('tryDispatchNext — brain offline, skipping');
      return;
    }

    if (this.robotService.isJobRunning()) {
      this.logger.debug('tryDispatchNext — brain busy, skipping');
      return;
    }

    const nextJob = await this.jobModel.findOneAndUpdate(
      { status: JobStatus.QUEUED },
      { $set: { status: JobStatus.DISPATCHED } },
      { new: true, sort: { queuedAt: 1 } },
    );
    if (!nextJob) {
      this.logger.debug('tryDispatchNext — queue empty');
      return;
    }

    await this.robotGateway.dispatchJob(nextJob);
    this.robotService.markJobRunning(nextJob._id);
    this.eventsGateway.emitJobUpdated(nextJob);
    this.logger.log(`Dispatched queued job ${nextJob._id}: ${nextJob.fromSlotCode} → ${nextJob.toSlotCode}`);
  }

  // ── CRUD helpers ────────────────────────────────────────────────────────

  async findAll(): Promise<Job[]> {
    return this.jobModel.find().sort({ createdAt: -1 }).lean();
  }

  async findById(id: string): Promise<Job | null> {
    return this.jobModel.findById(id).lean();
  }

  async findAllQueued(): Promise<Job[]> {
    return this.jobModel
      .find({ status: { $in: [JobStatus.QUEUED, JobStatus.DISPATCHED, JobStatus.IN_PROGRESS] } })
      .sort({ queuedAt: 1 })
      .lean();
  }

  async updateStatus(jobId: string, status: JobStatus): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (status === JobStatus.FAILED || status === JobStatus.COMPLETED) {
      // Clear running job tracking so queue can proceed.
      this.robotService.markJobIdle();
    }
    await this.jobModel.findByIdAndUpdate(jobId, update);
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
        // Attempt next queued job after this one finishes.
        await this.tryDispatchNext();
      }
    }
  }

  async updatePhase(jobId: string, phase: JobPhase): Promise<void> {
    await this.jobModel.findByIdAndUpdate(jobId, { phase });
    const job = await this.jobModel.findById(jobId);
    if (job) this.eventsGateway.emitJobUpdated(job);
  }

  async updateTiming(
    jobId: string,
    timing: {
      startedAt?: Date;
      pickupAt?: Date;
      dropoffAt?: Date;
      unloadAt?: Date;
      totalDurationMs?: number;
      fullCycleDurationMs?: number;
      travelToPickupMs?: number;
      travelToDropoffMs?: number;
      unloadDurationMs?: number;
    },
  ): Promise<void> {
    const job = await this.jobModel.findByIdAndUpdate(jobId, timing, { new: true });
    if (!job) throw new NotFoundException(`Không tìm thấy job "${jobId}"`);
    this.eventsGateway.emitJobUpdated(job);
    this.logger.log(`Job ${jobId} timing updated: total=${timing.totalDurationMs ?? '?'}ms`);
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = await this.jobModel.findById(jobId);
    if (!job) throw new NotFoundException(`Không tìm thấy job "${jobId}"`);
    if (job.status === JobStatus.COMPLETED || job.status === JobStatus.CANCELLED)
      throw new NotFoundException(`Job "${jobId}" đã kết thúc`);

    // Release reserved slots.
    await this.shelfService.updateSlotStatus(job.fromSlotCode, SlotStatus.AVAILABLE);
    await this.shelfService.updateSlotStatus(job.toSlotCode, SlotStatus.AVAILABLE);

    await this.jobModel.findByIdAndUpdate(jobId, {
      status: JobStatus.CANCELLED,
      failureReason: 'Cancelled by user',
    });
    const updated = await this.jobModel.findById(jobId);
    if (updated) this.eventsGateway.emitJobUpdated(updated);

    this.logger.log(`Job ${jobId} cancelled`);
  }
}
