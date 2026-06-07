import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class AssignCoordinatesDto {
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
