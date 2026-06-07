import { BadRequestException, forwardRef,Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Types } from 'mongoose';

import { EventsGateway } from '../../gateway/events-gateway';
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
    @Inject(forwardRef(() => PackageService))
    private readonly packageService: PackageService,
    private readonly eventsGateway: EventsGateway,
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
      throw new NotFoundException(`Không tìm thấy vị trí "${slotCode}"`);
    }

    if (slot.status === SlotStatus.OCCUPIED) {
      throw new BadRequestException(`Vị trí "${slotCode}" đã có hàng hóa`);
    }

    const alreadyAssigned = await this.shelfRepository.findSlotByPackageId(packageObjectId);
    if (alreadyAssigned) {
      throw new BadRequestException(`Package "${packageId}" đã được đặt tại vị trí "${alreadyAssigned.code}"`);
    }

    const updated = await this.shelfRepository.assignPackageToSlot(slotCode, packageObjectId);
    if (!updated) {
      throw new NotFoundException(`Không tìm thấy vị trí "${slotCode}"`);
    }
    this.eventsGateway.emitShelfUpdated(updated);
    return updated;
  }

  async movePackage(fromSlotCode: string, targetSlotCode: string): Promise<ShelfSlot> {
    const fromSlot = await this.shelfRepository.findSlotByCode(fromSlotCode);
    if (!fromSlot) {
      throw new NotFoundException(`Không tìm thấy vị trí nguồn "${fromSlotCode}"`);
    }
    if (fromSlot.status === SlotStatus.AVAILABLE || !fromSlot.packageId) {
      throw new BadRequestException(`Vị trí "${fromSlotCode}" không có package để di chuyển`);
    }

    const targetSlot = await this.shelfRepository.findSlotByCode(targetSlotCode);
    if (!targetSlot) {
      throw new NotFoundException(`Không tìm thấy vị trí đích "${targetSlotCode}"`);
    }
    if (targetSlot.status === SlotStatus.OCCUPIED) {
      throw new BadRequestException(`Vị trí đích "${targetSlotCode}" đã có hàng hóa`);
    }

    const packageId = fromSlot.packageId;
    await this.shelfRepository.clearSlot(fromSlotCode);
    const updated = await this.shelfRepository.assignPackageToSlot(targetSlotCode, packageId);
    if (!updated) {
      throw new NotFoundException(`Không tìm thấy vị trí đích "${targetSlotCode}"`);
    }
    this.eventsGateway.emitShelfUpdated(updated);
    return updated;
  }

  async removePackage(slotCode: string): Promise<void> {
    const slot = await this.shelfRepository.findSlotByCode(slotCode);
    if (!slot) {
      throw new NotFoundException(`Không tìm thấy vị trí "${slotCode}"`);
    }
    if (slot.status === SlotStatus.AVAILABLE) {
      throw new BadRequestException(`Vị trí "${slotCode}" đang trống`);
    }

    const packageId = slot.packageId?.toString() ?? null;
    await this.shelfRepository.clearSlot(slotCode);

    if (packageId) {
      try {
        await this.packageService.markFinished(packageId);
      } catch (err) {
        console.error(`Không thể cập nhật package ${packageId} sang FINISHED sau khi gỡ khỏi kệ ${slotCode}`, err);
      }
    }

    this.eventsGateway.emitShelfUpdated({ code: slotCode, status: SlotStatus.AVAILABLE, packageId: null });
  }

  async clearSlotByPackageId(packageId: string): Promise<ShelfSlot | null> {
    const packageObjectId = new Types.ObjectId(packageId);
    const slot = await this.shelfRepository.clearSlotByPackageId(packageObjectId);
    if (slot) {
      this.eventsGateway.emitShelfUpdated(slot);
    }
    return slot;
  }

  async assignCoordinates(
    slotCode: string,
    slotX: number,
    slotY: number,
    facingTheta: number | null,
  ): Promise<ShelfSlot> {
    const slot = await this.shelfRepository.findSlotByCode(slotCode);
    if (!slot) {
      throw new NotFoundException(`Không tìm thấy vị trí "${slotCode}"`);
    }
    const updated = await this.shelfRepository.updateCoordinates(slotCode, slotX, slotY, facingTheta);
    if (!updated) {
      throw new NotFoundException(`Không tìm thấy vị trí "${slotCode}"`);
    }
    this.eventsGateway.emitShelfUpdated(updated);
    return updated;
  }

  async assignAprilTag(slotCode: string, aprilTagId: number): Promise<ShelfSlot> {
    if (aprilTagId < 0 || aprilTagId > 586) {
      throw new BadRequestException('aprilTagId phải nằm trong khoảng 0..586');
    }
    const conflict = await this.shelfRepository.findByAprilTagId(aprilTagId);
    if (conflict && conflict.code !== slotCode) {
      throw new BadRequestException(`aprilTagId ${String(aprilTagId)} đã được gán cho vị trí "${conflict.code}"`);
    }
    const slot = await this.shelfRepository.findSlotByCode(slotCode);
    if (!slot) {
      throw new NotFoundException(`Không tìm thấy vị trí "${slotCode}"`);
    }
    const updated = await this.shelfRepository.assignAprilTag(slotCode, aprilTagId);
    if (!updated) {
      throw new NotFoundException(`Không tìm thấy vị trí "${slotCode}"`);
    }
    this.eventsGateway.emitShelfUpdated(updated);
    return updated;
  }

  async findByAprilTagId(aprilTagId: number): Promise<ShelfSlot | null> {
    return this.shelfRepository.findByAprilTagId(aprilTagId);
  }

  async assignCoordinatesBatch(
    entries: { slotCode: string; slotX: number; slotY: number; facingTheta: number | null }[],
  ): Promise<ShelfSlot[]> {
    const updated: ShelfSlot[] = [];
    for (const entry of entries) {
      const slot = await this.assignCoordinates(entry.slotCode, entry.slotX, entry.slotY, entry.facingTheta);
      updated.push(slot);
    }
    return updated;
  }
}
