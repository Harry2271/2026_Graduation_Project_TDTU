import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AssignPackageDto } from './dto/assign-package.dto';
import { MovePackageDto } from './dto/move-package.dto';
import { Shelf } from './schemas/shelf.schema';
import { ShelfSlot } from './schemas/shelf-slot.schema';
import { ShelfService } from './shelf-service';

@ApiTags('shelves')
@Controller('shelves')
export class ShelfController {
  constructor(private readonly shelfService: ShelfService) {}

  @Get()
  @ApiOperation({ summary: 'Get all shelves' })
  @ApiResponse({ status: 200, description: 'List of shelves', type: [Shelf] })
  findAllShelves(): Promise<Shelf[]> {
    return this.shelfService.findAllShelves();
  }

  @Get('slots')
  @ApiOperation({ summary: 'Get all slots across all shelves' })
  @ApiResponse({ status: 200, description: 'All slots', type: [ShelfSlot] })
  findAllSlots(): Promise<ShelfSlot[]> {
    return this.shelfService.findAllSlots();
  }

  @Get(':shelfCode/slots')
  @ApiOperation({ summary: 'Get slots by shelf code (A, B, C, D)' })
  @ApiResponse({ status: 200, description: 'Slots for the specified shelf', type: [ShelfSlot] })
  findSlotsByShelf(@Param('shelfCode') shelfCode: string): Promise<ShelfSlot[]> {
    return this.shelfService.findSlotsByShelf(shelfCode.toUpperCase());
  }

  @Post(':slotCode/package')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a package to a slot (slot must be empty and available)' })
  @ApiResponse({ status: 201, description: 'Package assigned to slot', type: ShelfSlot })
  @ApiResponse({ status: 400, description: 'Slot is not available or package already assigned elsewhere' })
  @ApiResponse({ status: 404, description: 'Slot or package not found' })
  assignPackage(
    @Param('slotCode') slotCode: string,
    @Body() dto: AssignPackageDto,
  ): Promise<ShelfSlot> {
    return this.shelfService.assignPackage(slotCode.toUpperCase(), dto.packageId);
  }

  @Put(':slotCode/package')
  @ApiOperation({ summary: 'Move a package from one slot to another (target must be empty)' })
  @ApiResponse({ status: 200, description: 'Package moved to new slot', type: ShelfSlot })
  @ApiResponse({ status: 400, description: 'Source slot is empty or target slot is occupied' })
  @ApiResponse({ status: 404, description: 'Slot not found' })
  movePackage(
    @Param('slotCode') slotCode: string,
    @Body() dto: MovePackageDto,
  ): Promise<ShelfSlot> {
    return this.shelfService.movePackage(slotCode.toUpperCase(), dto.targetSlotCode.toUpperCase());
  }

  @Delete(':slotCode/package')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a package from a slot' })
  @ApiResponse({ status: 204, description: 'Package removed from slot' })
  @ApiResponse({ status: 400, description: 'Slot is already empty' })
  @ApiResponse({ status: 404, description: 'Slot not found' })
  removePackage(@Param('slotCode') slotCode: string): Promise<void> {
    return this.shelfService.removePackage(slotCode.toUpperCase());
  }
}
