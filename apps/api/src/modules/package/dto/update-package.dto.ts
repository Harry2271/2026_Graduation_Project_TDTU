import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { PackageStatus, PackageZone } from '../schemas/package.schema';

export class UpdatePackageDto {
  @ApiPropertyOptional({ description: 'Updated name of the package', example: 'Premium Parking Package' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  packageName?: string;

  @ApiPropertyOptional({
    description: 'Lifecycle status of the package. Only used internally by the service layer for status transitions.',
    enum: PackageStatus,
  })
  @IsOptional()
  status?: PackageStatus;

  @ApiPropertyOptional({
    description:
      'AprilTag ID (0..586). Only used internally by the service layer for tagId reallocation/clearing on status change.',
    example: 42,
    nullable: true,
    minimum: 0,
    maximum: 586,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(586)
  tagId?: number | null;

  @ApiPropertyOptional({
    description: 'Zone code the package belongs to. Cleared on FINISHED.',
    enum: PackageZone,
    nullable: true,
  })
  @IsOptional()
  @IsEnum(PackageZone)
  zoneCode?: PackageZone | null;
}
