import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HydratedDocument, Types } from 'mongoose';

export type ShelfSlotDocument = HydratedDocument<ShelfSlot>;

export enum SlotStatus {
  AVAILABLE = 'AVAILABLE',
  OCCUPIED = 'OCCUPIED',
  RESERVED = 'RESERVED',
  TRANSIT = 'TRANSIT',
}

@Schema({ timestamps: true })
export class ShelfSlot {
  @ApiProperty({ description: 'Slot code, e.g. S1A1 (shelf=S1, row=A, column=1)', example: 'S1A1' })
  @Prop({ required: true, unique: true })
  code!: string;

  @ApiProperty({ description: 'Shelf identifier (S1, S2, S3, S4)', example: 'S1' })
  @Prop({ required: true })
  shelf!: string;

  @ApiProperty({ description: 'Row letter (A-D)', example: 'A' })
  @Prop({ required: true })
  row!: string;

  @ApiProperty({ description: 'Column number (1-4)', example: 1 })
  @Prop({ required: true })
  column!: number;

  @ApiProperty({ enum: SlotStatus, description: 'Slot availability status', example: SlotStatus.AVAILABLE })
  @Prop({ required: true, enum: SlotStatus, default: SlotStatus.AVAILABLE })
  status!: SlotStatus;

  @ApiPropertyOptional({ description: 'ID of the package occupying this slot', example: '6771a2b3c4d5e6f7a8b9c0d1', nullable: true })
  @Prop({ type: Types.ObjectId, ref: 'Package', default: null })
  packageId!: Types.ObjectId | null;

  @ApiPropertyOptional({ description: 'X coordinate in SLAM map frame (meters), set during Calibrate', example: 1.5, nullable: true })
  @Prop({ required: false, default: null })
  slotX?: number;

  @ApiPropertyOptional({ description: 'Y coordinate in SLAM map frame (meters), set during Calibrate', example: -2.3, nullable: true })
  @Prop({ required: false, default: null })
  slotY?: number;

  @ApiPropertyOptional({ description: 'Yaw the robot must face when stopped at this slot (radians), set during Calibrate', example: 1.5708, nullable: true })
  @Prop({ required: false, default: null })
  facingTheta?: number;

  @ApiPropertyOptional({ description: 'Cho phép sử dụng tọa độ cố định (fallback) khi không quét được AprilTag', example: true })
  @Prop({ required: false, default: false })
  allowNoTagFallback?: boolean;

  @ApiPropertyOptional({ description: 'Tọa độ X fallback (meters) trong map frame', example: 1.18, nullable: true })
  @Prop({ required: false, default: null })
  fallbackX?: number | null;

  @ApiPropertyOptional({ description: 'Tọa độ Y fallback (meters) trong map frame', example: 2.38, nullable: true })
  @Prop({ required: false, default: null })
  fallbackY?: number | null;

  @ApiPropertyOptional({ description: 'Hướng quay (radians) fallback', example: 1.57, nullable: true })
  @Prop({ required: false, default: null })
  fallbackTheta?: number | null;

  @ApiPropertyOptional({ description: 'Fixed AprilTag ID for this slot (0..586), set during Calibrate', example: 42, nullable: true })
  @Prop({ required: false, default: null })
  aprilTagId?: number;
}

export const ShelfSlotSchema = SchemaFactory.createForClass(ShelfSlot);

// Sparse unique index so the 64 seeded slots (all with aprilTagId: null)
// can coexist. Only slots with a real aprilTagId are checked for
// uniqueness. Mirrors the partial-index pattern on Package.tagId.
ShelfSlotSchema.index(
  { aprilTagId: 1 },
  { unique: true, partialFilterExpression: { aprilTagId: { $type: 'number' } } },
);
