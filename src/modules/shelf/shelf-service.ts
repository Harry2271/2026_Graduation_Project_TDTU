import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Types } from 'mongoose';

import { PackageService } from '../package/package-service';
import { IShelfRepository } from './interfaces/shelf-repository.interface';
import { IShelfService } from './interfaces/shelf-service.interface';
import { Shelf } from './schemas/shelf.schema';
import { ShelfSlot, SlotStatus } from './schemas/shelf-slot.schema';
import { ISHELF_REPOSITORY } from './shelf.token';

@Injectable()
export class ShelfService implements IShelfService, OnModuleInit {
  private readonly SHELF_CODES = ['S1', 'S2', 'S3', 'S4'];
  private readonly ROW_LETTERS = ['A', 'B', 'C', 'D'];
  private readonly ROWS = 4;
  private readonly COLUMNS = 4;

  constructor(
    @Inject(ISHELF_REPOSITORY)
    private readonly shelfRepository: IShelfRepository,
    private readonly packageService: PackageService,
  ) {}

  async onModuleInit() {
    await this.initialize();
  }

  async initialize(): Promise<void> {
    const existing = await this.shelfRepository.countShelves();
    if (existing > 0) {
      return;
    }

    const shelves: Shelf[] = this.SHELF_CODES.map((code) => ({
      code,
      rows: this.ROWS,
      columns: this.COLUMNS,
      totalSlots: this.ROWS * this.COLUMNS,
    }));

    const slots: ShelfSlot[] = [];
    for (const shelfCode of this.SHELF_CODES) {
      for (const rowLetter of this.ROW_LETTERS) {
        for (let col = 1; col <= this.COLUMNS; col++) {
          slots.push({
            code: `${shelfCode}${rowLetter}${String(col)}`,
            shelf: shelfCode,
            row: rowLetter,
            column: col,
            status: SlotStatus.AVAILABLE,
            packageId: null,
          });
        }
      }
    }

    for (const shelf of shelves) {
      await this.shelfRepository.createShelf(shelf);
    }
    await this.shelfRepository.createSlots(slots);
  }

  async findAllShelves(): Promise<Shelf[]> {
    return this.shelfRepository.findAllShelves();
  }

  async findAllSlots(): Promise<ShelfSlot[]> {
    return this.shelfRepository.findAllSlots();
  }

  async findSlotsByShelf(shelfCode: string): Promise<ShelfSlot[]> {
    return this.shelfRepository.findSlotsByShelf(shelfCode);
  }

  async assignPackage(slotCode: string, packageId: string): Promise<ShelfSlot> {
    const packageObjectId = new Types.ObjectId(packageId);
    await this.packageService.findById(packageId);

    const slot = await this.shelfRepository.findSlotByCode(slotCode);
    if (!slot) {
      throw new NotFoundException(`Slot "${slotCode}" not found`);
    }

    if (slot.status === SlotStatus.OCCUPIED) {
      throw new BadRequestException(`Slot "${slotCode}" is already occupied`);
    }

    const alreadyAssigned = await this.shelfRepository.findSlotByPackageId(packageObjectId);
    if (alreadyAssigned) {
      throw new BadRequestException(`Package "${packageId}" is already assigned to slot "${alreadyAssigned.code}"`);
    }

    const updated = await this.shelfRepository.assignPackageToSlot(slotCode, packageObjectId);
    if (!updated) {
      throw new NotFoundException(`Slot "${slotCode}" not found`);
    }
    return updated;
  }

  async movePackage(fromSlotCode: string, targetSlotCode: string): Promise<ShelfSlot> {
    const fromSlot = await this.shelfRepository.findSlotByCode(fromSlotCode);
    if (!fromSlot) {
      throw new NotFoundException(`Slot "${fromSlotCode}" not found`);
    }
    if (fromSlot.status === SlotStatus.AVAILABLE || !fromSlot.packageId) {
      throw new BadRequestException(`Slot "${fromSlotCode}" has no package to move`);
    }

    const targetSlot = await this.shelfRepository.findSlotByCode(targetSlotCode);
    if (!targetSlot) {
      throw new NotFoundException(`Target slot "${targetSlotCode}" not found`);
    }
    if (targetSlot.status === SlotStatus.OCCUPIED) {
      throw new BadRequestException(`Target slot "${targetSlotCode}" is already occupied`);
    }

    const packageId = fromSlot.packageId;
    await this.shelfRepository.clearSlot(fromSlotCode);
    const updated = await this.shelfRepository.assignPackageToSlot(targetSlotCode, packageId);
    if (!updated) {
      throw new NotFoundException(`Target slot "${targetSlotCode}" not found`);
    }
    return updated;
  }

  async removePackage(slotCode: string): Promise<void> {
    const slot = await this.shelfRepository.findSlotByCode(slotCode);
    if (!slot) {
      throw new NotFoundException(`Slot "${slotCode}" not found`);
    }
    if (slot.status === SlotStatus.AVAILABLE) {
      throw new BadRequestException(`Slot "${slotCode}" is already empty`);
    }
    await this.shelfRepository.clearSlot(slotCode);
  }
}
