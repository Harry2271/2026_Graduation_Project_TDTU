import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Simplified AGV workflow — robot drives from home directly to a destination
 * slot (AprilTag-calibrated) and unloads. There is no source-slot pickup
 * step and no Package is tracked on the robot in the DB.
 */
export class DispatchMoveDto {
  @ApiProperty({ example: 'S2C3', description: 'AVAILABLE destination slot that has been Calibrated (slotX/Y/facingTheta/aprilTagId)' })
  @IsString()
  @IsNotEmpty()
  toSlotCode!: string;

  @ApiPropertyOptional({ description: 'Client-supplied idempotency key — duplicate dispatches collapse to one job' })
  @IsOptional()
  @IsString()
  operationId?: string;
}
