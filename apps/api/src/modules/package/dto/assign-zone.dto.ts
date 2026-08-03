import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { PackageZone } from '../schemas/package.schema';

export class AssignZoneDto {
  @ApiPropertyOptional({
    description: 'Zone code to assign to the package. Set to null to unassign.',
    enum: PackageZone,
    example: 'S1',
    nullable: true,
  })
  @IsOptional()
  @IsEnum(PackageZone)
  zoneCode?: PackageZone | null;
}
