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
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CreatePackageDto } from './dto/create-package.dto';
import { PackagePaginatedResponseDto } from './dto/package-paginated-response.dto';
import { PaginatedResponseDto, PaginationQueryDto } from './dto/pagination.dto';
import { UpdatePackageDto } from './dto/update-package.dto';
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
}
