import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreatePackageDto {
  @ApiProperty({ description: 'Name of the package', example: 'Basic Parking Package' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  packageName: string;
}
