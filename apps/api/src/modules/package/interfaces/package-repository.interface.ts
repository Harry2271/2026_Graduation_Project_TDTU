import type { CreatePackageDto } from '../dto/create-package.dto';
import type { PaginationQueryDto } from '../dto/pagination.dto';
import type { UpdatePackageDto } from '../dto/update-package.dto';
import type { CreatePackageInput } from '../package-repository';
import type { Package } from '../schemas/package.schema';

export const IPACKAGE_REPOSITORY = 'IPACKAGE_REPOSITORY';

export interface IPackageRepository {
  create(dto: CreatePackageInput): Promise<Package>;
  findAll(): Promise<Package[]>;
  findAllPaginated(pagination: PaginationQueryDto): Promise<{ items: Package[]; total: number }>;
  findById(id: string): Promise<Package | null>;
  update(id: string, dto: UpdatePackageDto): Promise<Package | null>;
  remove(id: string): Promise<void>;
  findAllocatedTagIds(): Promise<number[]>;
}

export type { CreatePackageDto, UpdatePackageDto };
