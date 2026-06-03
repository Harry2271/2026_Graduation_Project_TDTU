import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { PackageStatus } from '../schemas/package.schema';

export class UpdatePackageStatusDto {
  @ApiProperty({
    description: 'New status for the package',
    enum: PackageStatus,
    example: PackageStatus.IN_PROGRESS,
  })
  @IsEnum(PackageStatus)
  status!: PackageStatus;
}
