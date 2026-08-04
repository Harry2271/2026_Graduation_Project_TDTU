import { ApiProperty } from '@nestjs/swagger';

import { PackageZone } from '../schemas/package.schema';

export class PackageStatsResponseDto {
  @ApiProperty({ description: 'Tổng số package đang hoạt động (không bao gồm FINISHED)', example: 42 })
  total!: number;

  @ApiProperty({ description: 'Số package chưa được gán zone', example: 10 })
  unplaced!: number;

  @ApiProperty({
    description: 'Số package theo từng zone',
    example: { S1: 8, S2: 12, S3: 7, S4: 5 },
  })
  zones!: Record<PackageZone, number>;
}
