import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CreatePackageDto } from './dto/create-package.dto';
import { PaginationQueryDto } from './dto/pagination.dto';
import { UpdatePackageDto } from './dto/update-package.dto';
import { IPACKAGE_REPOSITORY } from './interfaces/package-repository.interface';
import { IPackageRepository } from './interfaces/package-repository.interface';
import { Package, PackageDocument, PackageStatus, PackageZone } from './schemas/package.schema';

export interface CreatePackageInput extends CreatePackageDto {
  status: PackageStatus;
  tagId: number | null;
  zoneCode: PackageZone | null;
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

  async assignZone(id: string, zoneCode: PackageZone | null): Promise<Package | null> {
    return this.packageModel
      .findByIdAndUpdate(id, { zoneCode }, { new: true })
      .lean()
      .exec();
  }

  async getActiveStats(): Promise<{ total: number; unplaced: number; zones: Record<PackageZone, number> }> {
    const grouped = await this.packageModel
      .aggregate<{ _id: PackageZone | null; count: number }>([
        { $match: { status: { $ne: PackageStatus.FINISHED } } },
        { $group: { _id: '$zoneCode', count: { $sum: 1 } } },
      ])
      .exec();

    const zones: Record<PackageZone, number> = {
      [PackageZone.S1]: 0,
      [PackageZone.S2]: 0,
      [PackageZone.S3]: 0,
      [PackageZone.S4]: 0,
    };
    let unplaced = 0;
    let total = 0;
    for (const group of grouped) {
      total += group.count;
      if (group._id === null) {
        unplaced = group.count;
      } else if (group._id in zones) {
        zones[group._id] = group.count;
      }
    }

    return { total, unplaced, zones };
  }
}

export const PackageRepositoryProvider = {
  provide: IPACKAGE_REPOSITORY,
  useClass: PackageRepository,
};