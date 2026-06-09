import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DispatchMoveDto {
  @ApiProperty({ example: 'S1A1' })
  @IsString()
  @IsNotEmpty()
  fromSlotCode!: string;

  @ApiProperty({ example: 'S2C3' })
  @IsString()
  @IsNotEmpty()
  toSlotCode!: string;
}
