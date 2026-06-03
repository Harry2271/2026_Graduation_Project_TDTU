import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CreatePackageDto } from './dto/create-package.dto';
import { PaginationQueryDto } from './dto/pagination.dto';
import { UpdatePackageDto } from './dto/update-package.dto';
import { IPACKAGE_REPOSITORY } from './interfaces/package-repository.interface';
import { IPackageRepository } from './interfaces/package-repository.interface';
import { Package, PackageDocument, PackageStatus } from './schemas/package.schema';

export interface CreatePackageInput extends CreatePackageDto {
  status: PackageStatus;
  tagId: number | null;
}

@Injectable()
export class PackageRepository implements IPackageRepository {
  constructor(
    @InjectModel(Package.name)
    private readonly packageModel: Model<PackageDocument>,
  ) {}

  async create(dto: CreatePackageInput): Promise<Package> {
    const created = new this.packageModel(dto);
    return created.save();
  }

  async findAll(): Promise<Package[]> {
    return this.packageModel.find().exec();
  }

  async findAllPaginated(pagination: PaginationQueryDto): Promise<{ items: Package[]; total: number }> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 10;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.packageModel.find().skip(skip).limit(limit).exec(),
      this.packageModel.countDocuments().exec(),
    ]);

    return { items, total };
  }

  async findById(id: string): Promise<Package | null> {
    return this.packageModel.findById(id).exec();
  }

  async update(id: string, dto: UpdatePackageDto): Promise<Package | null> {
    return this.packageModel.findByIdAndUpdate(id, dto, { new: true }).exec();
  }

  async remove(id: string): Promise<void> {
    await this.packageModel.findByIdAndDelete(id).exec();
  }

  async findAllocatedTagIds(): Promise<number[]> {
    const docs = await this.packageModel
      .find({ tagId: { $ne: null } }, { tagId: 1, _id: 0 })
      .lean()
      .exec();

    return docs.flatMap((doc) => (typeof doc.tagId === 'number' ? [doc.tagId] : []));
  }
}

export const PackageRepositoryProvider = {
  provide: IPACKAGE_REPOSITORY,
  useClass: PackageRepository,
};
