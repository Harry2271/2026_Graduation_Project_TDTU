import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CoordinatesBatchEntryDto {
  @IsString()
  slotCode!: string;

  @IsNumber()
  @Min(-100)
  @Max(100)
  slotX!: number;

  @IsNumber()
  @Min(-100)
  @Max(100)
  slotY!: number;

  @IsOptional()
  @IsNumber()
  @Min(-Math.PI)
  @Max(Math.PI)
  facingTheta?: number;
}

export class AssignCoordinatesBatchDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CoordinatesBatchEntryDto)
  entries!: CoordinatesBatchEntryDto[];
}
