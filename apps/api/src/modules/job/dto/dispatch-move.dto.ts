import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class DispatchMoveDto {
  @ApiProperty({ example: 'S1A1' })
  @IsString()
  @IsNotEmpty()
  fromSlotCode!: string;

  @ApiProperty({ example: 'S2C3' })
  @IsString()
  @IsNotEmpty()
  toSlotCode!: string;

  @ApiPropertyOptional({ description: 'Client-supplied idempotency key — duplicate dispatches collapse to one job' })
  @IsOptional()
  @IsString()
  operationId?: string;
}
