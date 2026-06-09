import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JobService } from '../job/job.service';
import { AssignAprilTagDto } from './dto/assign-april-tag.dto';
import { AssignCoordinatesDto } from './dto/assign-coordinates.dto';
import { AssignCoordinatesBatchDto } from './dto/assign-coordinates-batch.dto';
import { AssignPackageDto } from './dto/assign-package.dto';
import { MovePackageDto } from './dto/move-package.dto';
import { Shelf } from './schemas/shelf.schema';
import { ShelfSlot } from './schemas/shelf-slot.schema';
import { ShelfService } from './shelf-service';

@ApiTags('shelves')
@Controller('shelves')
export class ShelfController {
  constructor(
    private readonly shelfService: ShelfService,
    private readonly jobService: JobService,
  ) {}

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
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Move a package via AGV robot (returns jobId)' })
  @ApiResponse({ status: 202, description: 'Job dispatched' })
  @ApiResponse({ status: 400, description: 'Invalid move' })
  @ApiResponse({ status: 404, description: 'Slot not found' })
  movePackage(
    @Param('slotCode') slotCode: string,
    @Body() dto: MovePackageDto,
  ): Promise<{ jobId: string }> {
    return this.jobService.dispatchMove({
      fromSlotCode: slotCode.toUpperCase(),
      toSlotCode: dto.targetSlotCode.toUpperCase(),
    });
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

  @Put('coordinates/batch')
  @ApiOperation({ summary: 'Assign coordinates to multiple slots at once (Calibrate bulk)' })
  @ApiResponse({ status: 200, description: 'Coordinates assigned', type: [ShelfSlot] })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  assignCoordinatesBatch(@Body() dto: AssignCoordinatesBatchDto): Promise<ShelfSlot[]> {
    return this.shelfService.assignCoordinatesBatch(
      dto.entries.map((e) => ({
        slotCode: e.slotCode.toUpperCase(),
        slotX: e.slotX,
        slotY: e.slotY,
        facingTheta: e.facingTheta ?? null,
      })),
    );
  }

  @Put(':slotCode/coordinates')
  @ApiOperation({ summary: 'Assign (slotX, slotY, facingTheta) to a slot (Calibrate)' })
  @ApiResponse({ status: 200, description: 'Coordinates assigned', type: ShelfSlot })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 404, description: 'Slot not found' })
  assignCoordinates(
    @Param('slotCode') slotCode: string,
    @Body() dto: AssignCoordinatesDto,
  ): Promise<ShelfSlot> {
    return this.shelfService.assignCoordinates(
      slotCode.toUpperCase(),
      dto.slotX,
      dto.slotY,
      dto.facingTheta ?? null,
    );
  }

  @Get('april-tag/:aprilTagId')
  @ApiOperation({ summary: 'Look up a slot by its fixed AprilTag ID (used by robot vision)' })
  @ApiResponse({ status: 200, description: 'Slot found', type: ShelfSlot })
  @ApiResponse({ status: 404, description: 'No slot with that AprilTag ID' })
  findByAprilTagId(@Param('aprilTagId') aprilTagId: string): Promise<ShelfSlot> {
    const tagId = Number.parseInt(aprilTagId, 10);
    if (Number.isNaN(tagId) || tagId < 0 || tagId > 586) {
      throw new NotFoundException(`aprilTagId phải là số nguyên trong khoảng 0..586`);
    }
    return this.shelfService.findByAprilTagId(tagId).then((slot) => {
      if (!slot) {
        throw new NotFoundException(`Không tìm thấy vị trí với aprilTagId ${String(tagId)}`);
      }
      return slot;
    });
  }

  @Put(':slotCode/april-tag')
  @ApiOperation({ summary: 'Assign an AprilTag ID to a slot (Calibrate)' })
  @ApiResponse({ status: 200, description: 'AprilTag assigned', type: ShelfSlot })
  @ApiResponse({ status: 400, description: 'Validation failed or AprilTag already used' })
  @ApiResponse({ status: 404, description: 'Slot not found' })
  assignAprilTag(
    @Param('slotCode') slotCode: string,
    @Body() dto: AssignAprilTagDto,
  ): Promise<ShelfSlot> {
    return this.shelfService.assignAprilTag(slotCode.toUpperCase(), dto.aprilTagId);
  }
}
