import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { CreatePackageDto } from './dto/create-package.dto';
import { PaginatedResponseDto, PaginationMeta, PaginationQueryDto } from './dto/pagination.dto';
import { UpdatePackageDto } from './dto/update-package.dto';
import { IPACKAGE_REPOSITORY } from './interfaces/package-repository.interface';
import { IPackageRepository } from './interfaces/package-repository.interface';
import { IPackageService } from './interfaces/package-service.interface';
import { Package } from './schemas/package.schema';

@Injectable()
export class PackageService implements IPackageService {
  constructor(
    @Inject(IPACKAGE_REPOSITORY)
    private readonly packageRepository: IPackageRepository,
  ) {}

  async create(dto: CreatePackageDto): Promise<Package> {
    return this.packageRepository.create(dto);
  }

  async findAll(): Promise<Package[]> {
    return this.packageRepository.findAll();
  }

  async findAllPaginated(pagination: PaginationQueryDto): Promise<PaginatedResponseDto<Package>> {
    const { items, total } = await this.packageRepository.findAllPaginated(pagination);
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 10;

    const meta: PaginationMeta = {
      total,
      page,
      limit,
      hasNext: page * limit < total,
    };

    return { items, meta };
  }

  async findById(id: string): Promise<Package> {
    const found = await this.packageRepository.findById(id);
    if (!found) {
      throw new NotFoundException(`Không tìm thấy package với id "${id}"`);
    }
    return found;
  }

  async update(id: string, dto: UpdatePackageDto): Promise<Package> {
    const updated = await this.packageRepository.update(id, dto);
    if (!updated) {
      throw new NotFoundException(`Không tìm thấy package với id "${id}"`);
    }
    return updated;
  }

  async remove(id: string): Promise<void> {
    const found = await this.packageRepository.findById(id);
    if (!found) {
      throw new NotFoundException(`Không tìm thấy package với id "${id}"`);
    }
    await this.packageRepository.remove(id);
  }
}
