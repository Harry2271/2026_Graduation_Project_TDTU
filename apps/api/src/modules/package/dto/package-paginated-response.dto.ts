import { ApiProperty } from '@nestjs/swagger';

import { Package } from '../schemas/package.schema';
import { PaginationMeta } from './pagination.dto';

export class PackagePaginatedResponseDto {
  @ApiProperty({ type: [Package] })
  items!: Package[];

  @ApiProperty({ type: () => PaginationMeta })
  meta!: PaginationMeta;
}
