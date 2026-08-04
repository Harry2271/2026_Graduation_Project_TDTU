export type PackageStatus = 'CREATED' | 'IN_PROGRESS' | 'FINISHED';

export type ZoneCode = 'S1' | 'S2' | 'S3' | 'S4';

export interface Package {
  _id: string;
  packageName: string;
  status: PackageStatus;
  tagId: number | null;
  zoneCode: ZoneCode | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface PackageStats {
  total: number;
  unplaced: number;
  zones: Record<ZoneCode, number>;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
}

export interface PackagePaginatedResponseDto {
  items: Package[];
  meta: PaginationMeta;
}
