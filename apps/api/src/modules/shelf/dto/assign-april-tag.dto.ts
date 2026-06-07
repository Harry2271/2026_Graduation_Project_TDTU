import { IsInt, Max, Min } from 'class-validator';

export class AssignAprilTagDto {
  @IsInt()
  @Min(0)
  @Max(586)
  aprilTagId!: number;
}
