import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HydratedDocument, Types } from 'mongoose';

export type ShelfSlotDocument = HydratedDocument<ShelfSlot>;

export enum SlotStatus {
  AVAILABLE = 'AVAILABLE',
  OCCUPIED = 'OCCUPIED',
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
}

export const ShelfSlotSchema = SchemaFactory.createForClass(ShelfSlot);
