import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class MovePackageDto {
  @ApiProperty({ description: 'Slot code to move the package to', example: 'B23' })
  @IsNotEmpty()
  @IsString()
  targetSlotCode!: string;
}
