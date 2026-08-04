import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HydratedDocument } from 'mongoose';

export type PackageDocument = HydratedDocument<Package>;

export enum PackageStatus {
  CREATED = 'CREATED',
  IN_PROGRESS = 'IN_PROGRESS',
  FINISHED = 'FINISHED',
}

export enum PackageZone {
  S1 = 'S1',
  S2 = 'S2',
  S3 = 'S3',
  S4 = 'S4',
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

  @ApiPropertyOptional({
    description: 'Zone code the package belongs to (S1–S4). Multiple packages may share the same zone.',
    enum: PackageZone,
    example: 'S1',
    nullable: true,
  })
  @Prop({ type: String, enum: PackageZone, default: null })
  zoneCode!: PackageZone | null;
}

export const PackageSchema = SchemaFactory.createForClass(Package);

PackageSchema.index(
  { tagId: 1 },
  { unique: true, partialFilterExpression: { tagId: { $type: 'number' } } },
);
