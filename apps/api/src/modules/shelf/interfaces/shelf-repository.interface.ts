import type { Types } from 'mongoose';

import type { Shelf } from '../schemas/shelf.schema';
import type { ShelfSlot } from '../schemas/shelf-slot.schema';

export interface IShelfRepository {
  createShelf(shelf: Shelf): Promise<Shelf>;
  findAllShelves(): Promise<Shelf[]>;
  findAllSlots(): Promise<ShelfSlot[]>;
  findSlotsByShelf(shelfCode: string): Promise<ShelfSlot[]>;
  countShelves(): Promise<number>;
  createSlots(slots: ShelfSlot[]): Promise<void>;
  findSlotByCode(code: string): Promise<ShelfSlot | null>;
  findSlotByPackageId(packageId: Types.ObjectId): Promise<ShelfSlot | null>;
  findByAprilTagId(aprilTagId: number): Promise<ShelfSlot | null>;
  assignPackageToSlot(slotCode: string, packageId: Types.ObjectId): Promise<ShelfSlot | null>;
  clearSlot(slotCode: string): Promise<ShelfSlot | null>;
  clearSlotByPackageId(packageId: Types.ObjectId): Promise<ShelfSlot | null>;
  updateCoordinates(slotCode: string, slotX: number, slotY: number, facingTheta: number | null): Promise<ShelfSlot | null>;
  assignAprilTag(slotCode: string, aprilTagId: number): Promise<ShelfSlot | null>;
}
