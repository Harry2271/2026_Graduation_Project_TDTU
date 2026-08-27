import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AssignZoneDto } from './dto/assign-zone.dto';
import { CreatePackageDto } from './dto/create-package.dto';
import { PackagePaginatedResponseDto } from './dto/package-paginated-response.dto';
import { PackageStatsResponseDto } from './dto/package-stats-response.dto';
import { PaginatedResponseDto, PaginationQueryDto } from './dto/pagination.dto';
import { UpdatePackageDto } from './dto/update-package.dto';
import { UpdatePackageStatusDto } from './dto/update-package-status.dto';
import { PackageService } from './package-service';
import { Package } from './schemas/package.schema';

@ApiTags('packages')
@Controller('packages')
export class PackageController {
  constructor(private readonly packageService: PackageService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new package' })
  @ApiResponse({ status: 201, description: 'Package created successfully', type: Package })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  create(@Body() dto: CreatePackageDto): Promise<Package> {
    return this.packageService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all packages with pagination' })
  @ApiResponse({ status: 200, description: 'Paginated list of packages', type: PackagePaginatedResponseDto })
  findAll(@Query() pagination: PaginationQueryDto): Promise<PaginatedResponseDto<Package>> {
    return this.packageService.findAllPaginated(pagination);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get active package counts grouped by zone' })
  @ApiResponse({ status: 200, description: 'Active package stats', type: PackageStatsResponseDto })
  getStats(): Promise<PackageStatsResponseDto> {
    return this.packageService.getStats();
  }

  @Get('by-tag/:tagId')
  @ApiOperation({ summary: 'Find a package by its AprilTag ID' })
  @ApiResponse({ status: 200, description: 'Package found', type: Package })
  @ApiResponse({ status: 404, description: 'No package found with this tagId' })
  @ApiResponse({ status: 400, description: 'Invalid tagId (must be 0-586)' })
  findByTagId(@Param('tagId') tagIdStr: string): Promise<Package> {
    const tagId = Number.parseInt(tagIdStr, 10);
    if (Number.isNaN(tagId) || tagId < 0 || tagId > 586) {
      throw new BadRequestException(`tagId must be a number between 0 and 586`);
    }
    return this.packageService.findByTagId(tagId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a package by ID' })
  @ApiResponse({ status: 200, description: 'Package details', type: Package })
  @ApiResponse({ status: 404, description: 'Package not found' })
  findById(@Param('id') id: string): Promise<Package> {
    return this.packageService.findById(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a package by ID' })
  @ApiResponse({ status: 200, description: 'Package updated', type: Package })
  @ApiResponse({ status: 404, description: 'Package not found' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePackageDto,
  ): Promise<Package> {
    return this.packageService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a package by ID' })
  @ApiResponse({ status: 204, description: 'Package deleted' })
  @ApiResponse({ status: 404, description: 'Package not found' })
  remove(@Param('id') id: string): Promise<void> {
    return this.packageService.remove(id);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update the status (and tagId allocation) of a package' })
  @ApiResponse({ status: 200, description: 'Package status updated', type: Package })
  @ApiResponse({ status: 400, description: 'Invalid status transition or pool exhausted' })
  @ApiResponse({ status: 404, description: 'Package not found' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePackageStatusDto,
  ): Promise<Package> {
    return this.packageService.changeStatus(id, dto.status);
  }

  @Patch(':id/zone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign or clear the zone for a package' })
  @ApiResponse({ status: 200, description: 'Package zone updated', type: Package })
  @ApiResponse({ status: 400, description: 'Package is FINISHED' })
  @ApiResponse({ status: 404, description: 'Package not found' })
  updateZone(
    @Param('id') id: string,
    @Body() dto: AssignZoneDto,
  ): Promise<Package> {
    return this.packageService.assignZone(id, dto.zoneCode ?? null);
  }
}
