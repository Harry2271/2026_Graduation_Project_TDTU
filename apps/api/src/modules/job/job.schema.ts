import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { HydratedDocument } from 'mongoose';

export type JobDocument = HydratedDocument<Job>;

export enum JobStatus {
  QUEUED = 'QUEUED',
  DISPATCHED = 'DISPATCHED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum JobPhase {
  NONE = 'NONE',
  NAVIGATE_DROPOFF = 'NAVIGATE_DROPOFF',
  AT_DOCK = 'AT_DOCK',
  UNLOADING = 'UNLOADING',
  RETURNING = 'RETURNING',
}

@Schema({ timestamps: true, versionKey: false })
export class Job {
  _id!: string;

  // ── Simplified AGV workflow: only destination slot matters. ─────────
  // packageId and fromSlotCode remain optional in the schema so legacy jobs
  // (pre-simplification) still hydrate and render on the Jobs page.
  @Prop({ type: Types.ObjectId, ref: 'Package', required: false, default: null })
  packageId?: Types.ObjectId | null;

  @Prop({ required: false, default: '' })
  fromSlotCode?: string;

  @Prop({ required: true })
  toSlotCode!: string;

  @Prop({ type: String, enum: JobStatus, default: JobStatus.QUEUED })
  status!: JobStatus;

  // ── Queue + idempotency fields (Phase 2/3) ──────────────────────
  /** Client-supplied id so duplicate dispatches collapse to a single job. */
  @Prop({ type: String, sparse: true, index: true })
  operationId?: string;

  /** Retry counter — incremented every time the brain fails a phase. */
  @Prop({ type: Number, default: 0 })
  attempt!: number;

  /** When the job entered the queue. Used for FIFO ordering. */
  @Prop({ type: Date, default: () => new Date() })
  queuedAt!: Date;

  /** Last reported phase (brain-side) — survives reconnects. */
  @Prop({ type: String, enum: JobPhase, default: JobPhase.NONE })
  phase!: JobPhase;

  /** Free-form failure reason (brain or API side). */
  @Prop({ type: String })
  failureReason?: string;

  // ── Timing fields (small-scale delivery measurement) ──────────────
  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  pickupAt?: Date;

  @Prop({ type: Date })
  dropoffAt?: Date;

  @Prop({ type: Date })
  unloadAt?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  // Start → unload complete (the delivery duration shown to operators)
  @Prop({ type: Number })
  totalDurationMs?: number;

  // Start → unload → return home
  @Prop({ type: Number })
  fullCycleDurationMs?: number;

  @Prop({ type: Number })
  travelToPickupMs?: number;

  @Prop({ type: Number })
  travelToDropoffMs?: number;

  @Prop({ type: Number })
  unloadDurationMs?: number;
}

export const JobSchema = SchemaFactory.createForClass(Job);
JobSchema.index({ createdAt: -1 });
JobSchema.index({ completedAt: -1, createdAt: -1 });
JobSchema.index({ status: 1, queuedAt: 1 });
