import { IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class AssignFallbackDto {
  @IsNumber()
  @Min(-100)
  @Max(100)
  fallbackX!: number;

  @IsNumber()
  @Min(-100)
  @Max(100)
  fallbackY!: number;

  @IsOptional()
  @IsNumber()
  @Min(-Math.PI)
  @Max(Math.PI)
  fallbackTheta?: number | null;

  @IsBoolean()
  allowNoTagFallback!: boolean;
}
