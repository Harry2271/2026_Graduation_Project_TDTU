import type { CreatePackageDto } from '../dto/create-package.dto';
import type { PaginatedResponseDto, PaginationQueryDto } from '../dto/pagination.dto';
import type { PackageStatsResponseDto } from '../dto/package-stats-response.dto';
import type { UpdatePackageDto } from '../dto/update-package.dto';
import type { Package, PackageStatus, PackageZone } from '../schemas/package.schema';

export interface IPackageService {
  create(dto: CreatePackageDto): Promise<Package>;
  findAll(): Promise<Package[]>;
  findAllPaginated(pagination: PaginationQueryDto): Promise<PaginatedResponseDto<Package>>;
  findById(id: string): Promise<Package>;
  findByTagId(tagId: number): Promise<Package>;
  update(id: string, dto: UpdatePackageDto): Promise<Package>;
  remove(id: string): Promise<void>;
  changeStatus(id: string, status: PackageStatus): Promise<Package>;
  markFinished(id: string): Promise<Package | null>;
  assignZone(id: string, zoneCode: PackageZone | null): Promise<Package>;
  getStats(): Promise<PackageStatsResponseDto>;
}
