import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';

import { IShelfRepository } from './interfaces/shelf-repository.interface';
import { Shelf, ShelfDocument } from './schemas/shelf.schema';
import { ShelfSlot, ShelfSlotDocument } from './schemas/shelf-slot.schema';
import { SlotStatus } from './schemas/shelf-slot.schema';
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

  async findSlotByCode(code: string, session?: ClientSession): Promise<ShelfSlot | null> {
    return session
      ? this.shelfSlotModel.findOne({ code }).session(session).exec()
      : this.shelfSlotModel.findOne({ code }).exec();
  }

  async findSlotByPackageId(packageId: Types.ObjectId): Promise<ShelfSlot | null> {
    return this.shelfSlotModel.findOne({ packageId }).exec();
  }

  async findByAprilTagId(aprilTagId: number): Promise<ShelfSlot | null> {
    return this.shelfSlotModel.findOne({ aprilTagId }).exec();
  }

  async assignPackageToSlot(slotCode: string, packageId: Types.ObjectId): Promise<ShelfSlot | null> {
    // Atomic: only assign if slot is AVAILABLE (direct assign) or RESERVED
    // (move workflow — slot was reserved in a previous step). A concurrent
    // TOCTOU race where two requests both see AVAILABLE will fail for the
    // second writer because the first already transitioned it to OCCUPIED.
    return this.shelfSlotModel
      .findOneAndUpdate(
        { code: slotCode, status: { $in: [SlotStatus.AVAILABLE, SlotStatus.RESERVED] }, packageId: null },
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

  async updateCoordinates(
    slotCode: string,
    slotX: number,
    slotY: number,
    facingTheta: number | null,
  ): Promise<ShelfSlot | null> {
    return this.shelfSlotModel
      .findOneAndUpdate(
        { code: slotCode },
        { $set: { slotX, slotY, facingTheta } },
        { new: true },
      )
      .exec();
  }

  async assignAprilTag(slotCode: string, aprilTagId: number): Promise<ShelfSlot | null> {
    return this.shelfSlotModel
      .findOneAndUpdate(
        { code: slotCode },
        { $set: { aprilTagId } },
        { new: true },
      )
      .exec();
  }

  async updateSlotStatus(slotCode: string, status: SlotStatus, session?: ClientSession): Promise<void> {
    const query = this.shelfSlotModel.updateOne({ code: slotCode }, { status });
    if (session) query.session(session);
    await query.exec();
  }

  async updateCoordinatesMany(
    entries: { slotCode: string; slotX: number; slotY: number; facingTheta: number | null }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const ops = entries.map((e) => ({
      updateOne: {
        filter: { code: e.slotCode },
        update: {
          $set: {
            slotX: e.slotX,
            slotY: e.slotY,
            facingTheta: e.facingTheta ?? undefined,
          },
        },
      },
    }));
    await this.shelfSlotModel.bulkWrite(ops, { ordered: false });
  }

  async reserveSlotIfAvailable(slotCode: string): Promise<ShelfSlot | null> {
    // Atomic reserve — only transitions AVAILABLE → RESERVED if slot is
    // still AVAILABLE. Concurrent move requests to the same target slot
    // will see null and fail fast instead of clobbering an existing package.
    return this.shelfSlotModel
      .findOneAndUpdate(
        { code: slotCode, status: SlotStatus.AVAILABLE },
        { status: SlotStatus.RESERVED },
        { new: true },
      )
      .exec();
  }
}

export const ShelfRepositoryProvider = {
  provide: ISHELF_REPOSITORY,
  useClass: ShelfRepository,
};
