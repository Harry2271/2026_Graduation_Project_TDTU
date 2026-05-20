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
}
