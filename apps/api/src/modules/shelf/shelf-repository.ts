import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { IShelfRepository } from './interfaces/shelf-repository.interface';
import { Shelf, ShelfDocument } from './schemas/shelf.schema';
import { ShelfSlot, ShelfSlotDocument, SlotStatus } from './schemas/shelf-slot.schema';
import { ISHELF_REPOSITORY } from './shelf.token';

@Injectable()
export class ShelfRepository implements IShelfRepository {
  constructor(
    @InjectModel(Shelf.name)
    private readonly shelfModel: Model<ShelfDocument>,
    @InjectModel(ShelfSlot.name)
    private readonly shelfSlotModel: Model<ShelfSlotDocument>,
  ) {}

  async countShelves(): Promise<number> {
    return this.shelfModel.countDocuments().exec();
  }

  async createShelf(shelf: Shelf): Promise<Shelf> {
    const created = new this.shelfModel(shelf);
    return created.save();
  }

  async findAllShelves(): Promise<Shelf[]> {
    return this.shelfModel.find().sort({ code: 1 }).exec();
  }

  async findAllSlots(): Promise<ShelfSlot[]> {
    return this.shelfSlotModel.find().sort({ code: 1 }).exec();
  }

  async findSlotsByShelf(shelfCode: string): Promise<ShelfSlot[]> {
    return this.shelfSlotModel.find({ shelf: shelfCode }).sort({ code: 1 }).exec();
  }

  async createSlots(slots: ShelfSlot[]): Promise<void> {
    await this.shelfSlotModel.insertMany(slots);
  }

  async findSlotByCode(code: string): Promise<ShelfSlot | null> {
    return this.shelfSlotModel.findOne({ code }).exec();
  }

  async findSlotByPackageId(packageId: Types.ObjectId): Promise<ShelfSlot | null> {
    return this.shelfSlotModel.findOne({ packageId }).exec();
  }

  async findByAprilTagId(aprilTagId: number): Promise<ShelfSlot | null> {
    return this.shelfSlotModel.findOne({ aprilTagId }).exec();
  }

  async assignPackageToSlot(slotCode: string, packageId: Types.ObjectId): Promise<ShelfSlot | null> {
    return this.shelfSlotModel
      .findOneAndUpdate(
        { code: slotCode },
        { packageId, status: SlotStatus.OCCUPIED },
        { new: true },
      )
      .exec();
  }

  async clearSlot(slotCode: string): Promise<ShelfSlot | null> {
    return this.shelfSlotModel
      .findOneAndUpdate(
        { code: slotCode },
        { packageId: null, status: SlotStatus.AVAILABLE },
        { new: true },
      )
      .exec();
  }

  async clearSlotByPackageId(packageId: Types.ObjectId): Promise<ShelfSlot | null> {
    return this.shelfSlotModel
      .findOneAndUpdate(
        { packageId },
        { packageId: null, status: SlotStatus.AVAILABLE },
        { new: true },
      )
      .exec();
  }
}

export const ShelfRepositoryProvider = {
  provide: ISHELF_REPOSITORY,
  useClass: ShelfRepository,
};
