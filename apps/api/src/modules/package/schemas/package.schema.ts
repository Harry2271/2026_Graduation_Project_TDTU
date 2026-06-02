import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiProperty } from '@nestjs/swagger';
import { HydratedDocument } from 'mongoose';

export type PackageDocument = HydratedDocument<Package>;

@Schema({ timestamps: true, versionKey: false })
export class Package {
  @ApiProperty({ description: 'Auto-generated MongoDB ID', example: '6771a2b3c4d5e6f7a8b9c0d1' })
  _id!: string;

  @ApiProperty({ description: 'Name of the package', example: 'Basic Parking Package' })
  @Prop({ required: true, maxlength: 255 })
  packageName!: string;
}

export const PackageSchema = SchemaFactory.createForClass(Package);
