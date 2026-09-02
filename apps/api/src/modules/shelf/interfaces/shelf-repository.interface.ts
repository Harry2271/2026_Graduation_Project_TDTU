import type { ClientSession, Types } from 'mongoose';

import type { Shelf } from '../schemas/shelf.schema';
import type { ShelfSlot, SlotStatus } from '../schemas/shelf-slot.schema';

export interface IShelfRepository {
  createShelf(shelf: Shelf): Promise<Shelf>;
  findAllShelves(): Promise<Shelf[]>;
  findAllSlots(): Promise<ShelfSlot[]>;
  findSlotsByShelf(shelfCode: string): Promise<ShelfSlot[]>;
  countShelves(): Promise<number>;
  createSlots(slots: ShelfSlot[]): Promise<void>;
  findSlotByCode(code: string, session?: ClientSession): Promise<ShelfSlot | null>;
  findSlotByPackageId(packageId: Types.ObjectId): Promise<ShelfSlot | null>;
  findByAprilTagId(aprilTagId: number): Promise<ShelfSlot | null>;
  assignPackageToSlot(slotCode: string, packageId: Types.ObjectId): Promise<ShelfSlot | null>;
  clearSlot(slotCode: string): Promise<ShelfSlot | null>;
  clearSlotByPackageId(packageId: Types.ObjectId): Promise<ShelfSlot | null>;
  updateCoordinates(slotCode: string, slotX: number, slotY: number, facingTheta: number | null): Promise<ShelfSlot | null>;
  updateFallback(slotCode: string, fallbackX: number, fallbackY: number, fallbackTheta: number | null, allowNoTagFallback: boolean): Promise<ShelfSlot | null>;
  assignAprilTag(slotCode: string, aprilTagId: number): Promise<ShelfSlot | null;
  updateSlotStatus(slotCode: string, status: SlotStatus, session?: ClientSession): Promise<void>;
  updateCoordinatesMany(entries: { slotCode: string; slotX: number; slotY: number; facingTheta: number | null }[]): Promise<void>;
  reserveSlotIfAvailable(slotCode: string): Promise<ShelfSlot | null>;
}
