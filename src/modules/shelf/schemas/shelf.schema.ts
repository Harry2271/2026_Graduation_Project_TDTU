import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiProperty } from '@nestjs/swagger';
import { HydratedDocument } from 'mongoose';

export type ShelfDocument = HydratedDocument<Shelf>;

@Schema({ timestamps: true })
export class Shelf {
  @ApiProperty({ description: 'Shelf identifier (S1, S2, S3, S4)', example: 'S1' })
  @Prop({ required: true, unique: true })
  code!: string;

  @ApiProperty({ description: 'Number of rows per shelf', example: 4 })
  @Prop({ required: true })
  rows!: number;

  @ApiProperty({ description: 'Number of columns per shelf', example: 4 })
  @Prop({ required: true })
  columns!: number;

  @ApiProperty({ description: 'Total slots in this shelf', example: 16 })
  @Prop({ required: true })
  totalSlots!: number;
}

export const ShelfSchema = SchemaFactory.createForClass(Shelf);
