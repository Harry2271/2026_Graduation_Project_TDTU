import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AssignPackageDto {
  @ApiProperty({ description: 'ID of the package to assign', example: '6771a2b3c4d5e6f7a8b9c0d1' })
  @IsNotEmpty()
  @IsString()
  packageId!: string;
}
