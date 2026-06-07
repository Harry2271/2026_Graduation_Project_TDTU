import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HydratedDocument } from 'mongoose';

export type PackageDocument = HydratedDocument<Package>;

export enum PackageStatus {
  CREATED = 'CREATED',
  IN_PROGRESS = 'IN_PROGRESS',
  FINISHED = 'FINISHED',
}

@Schema({ timestamps: true, versionKey: false })
export class Package {
  @ApiProperty({ description: 'Auto-generated MongoDB ID', example: '6771a2b3c4d5e6f7a8b9c0d1' })
  _id!: string;

  @ApiProperty({ description: 'Name of the package', example: 'Basic Parking Package' })
  @Prop({ required: true, maxlength: 255 })
  packageName!: string;

  @ApiProperty({
    description: 'Lifecycle status of the package',
    enum: PackageStatus,
    example: PackageStatus.CREATED,
  })
  @Prop({
    type: String,
    enum: PackageStatus,
    default: PackageStatus.CREATED,
    required: true,
  })
  status!: PackageStatus;

  @ApiProperty({
    description: 'AprilTag ID (0..586) allocated from the shared pool. Cleared when status is FINISHED.',
    example: 42,
    nullable: true,
    minimum: 0,
    maximum: 586,
  })
  @Prop({ type: Number, min: 0, max: 586, default: null })
  tagId!: number | null;

  @ApiPropertyOptional({ description: 'Source slot code, set when the user picks the source slot in the web UI', example: 'S1A1', nullable: true })
  @Prop({ type: String, default: null })
  sourceSlotCode!: string | null;

  @ApiPropertyOptional({ description: 'Target slot code, set when the user picks the destination slot in the web UI', example: 'S2C3', nullable: true })
  @Prop({ type: String, default: null })
  targetSlotCode!: string | null;
}

export const PackageSchema = SchemaFactory.createForClass(Package);

PackageSchema.index(
  { tagId: 1 },
  { unique: true, partialFilterExpression: { tagId: { $type: 'number' } } },
);
