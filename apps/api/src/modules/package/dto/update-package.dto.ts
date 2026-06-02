import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePackageDto {
  @ApiPropertyOptional({ description: 'Updated name of the package', example: 'Premium Parking Package' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  packageName?: string;
}
