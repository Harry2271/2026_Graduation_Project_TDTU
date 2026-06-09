import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { HydratedDocument } from 'mongoose';

export type JobDocument = HydratedDocument<Job>;

export enum JobStatus {
  DISPATCHED = 'DISPATCHED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Schema({ timestamps: true, versionKey: false })
export class Job {
  _id!: string;

  @Prop({ type: Types.ObjectId, ref: 'Package', required: true })
  packageId!: Types.ObjectId;

  @Prop({ required: true })
  fromSlotCode!: string;

  @Prop({ required: true })
  toSlotCode!: string;

  @Prop({ type: String, enum: JobStatus, default: JobStatus.DISPATCHED })
  status!: JobStatus;
}

export const JobSchema = SchemaFactory.createForClass(Job);
JobSchema.index({ createdAt: -1 });
