import type { Shelf } from '../schemas/shelf.schema';
import type { ShelfSlot } from '../schemas/shelf-slot.schema';

export interface IShelfService {
  initialize(): Promise<void>;
  findAllShelves(): Promise<Shelf[]>;
  findAllSlots(): Promise<ShelfSlot[]>;
  findSlotsByShelf(shelfCode: string): Promise<ShelfSlot[]>;
  assignPackage(slotCode: string, packageId: string): Promise<ShelfSlot>;
  movePackage(fromSlotCode: string, targetSlotCode: string): Promise<ShelfSlot>;
  removePackage(slotCode: string): Promise<void>;
  clearSlotByPackageId(packageId: string): Promise<ShelfSlot | null>;
  assignCoordinates(slotCode: string, slotX: number, slotY: number, facingTheta: number | null): Promise<ShelfSlot>;
  assignAprilTag(slotCode: string, aprilTagId: number): Promise<ShelfSlot>;
  findByAprilTagId(aprilTagId: number): Promise<ShelfSlot | null>;
  assignCoordinatesBatch(entries: { slotCode: string; slotX: number; slotY: number; facingTheta: number | null }[]): Promise<ShelfSlot[]>;
}
