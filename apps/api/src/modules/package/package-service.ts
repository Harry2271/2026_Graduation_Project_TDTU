import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';

import { EventsGateway } from '../../gateway/events-gateway';
import { runZoneMigration } from '../../scripts/migrate-package-zone';
import { ShelfService } from '../shelf/shelf-service';
import { CreatePackageDto } from './dto/create-package.dto';
import { PaginatedResponseDto, PaginationMeta, PaginationQueryDto } from './dto/pagination.dto';
import { PackageStatsResponseDto } from './dto/package-stats-response.dto';
import { UpdatePackageDto } from './dto/update-package.dto';
import { IPACKAGE_REPOSITORY } from './interfaces/package-repository.interface';
import { IPackageRepository } from './interfaces/package-repository.interface';
import { IPackageService } from './interfaces/package-service.interface';
import { Package, PackageStatus, PackageZone } from './schemas/package.schema';

@Injectable()
export class PackageService implements IPackageService, OnModuleInit {
  private static readonly TAG_ID_MIN = 0;
  private static readonly TAG_ID_MAX = 586;
  private static readonly ALLOCATE_RETRIES = 5;
  private static readonly DUPLICATE_KEY_ERROR_CODE = 11000;
  private readonly logger = new Logger(PackageService.name);

  constructor(
    @Inject(IPACKAGE_REPOSITORY)
    private readonly packageRepository: IPackageRepository,
    private readonly eventsGateway: EventsGateway,
    @Inject(forwardRef(() => ShelfService))
    private readonly shelfService: ShelfService,
  ) {}

  async onModuleInit(): Promise<void> {
    // One-time idempotent backfill. Nest calls this hook AFTER Mongoose has
    // finished initializing the connection, so connection.db is guaranteed
    // to be populated — no race with the driver like there was in main.ts.
    try {
      await runZoneMigration();
    } catch (error) {
      this.logger.error(
        `Zone migration failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  async create(dto: CreatePackageDto): Promise<Package> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < PackageService.ALLOCATE_RETRIES; attempt++) {
      const tagId = await this.pickLowestFreeTagId();
      try {
        const created = await this.packageRepository.create({
          ...dto,
          status: PackageStatus.CREATED,
          tagId,
          zoneCode: null,
        });
        this.eventsGateway.emitPackageCreated(created);
        return created;
      } catch (err: unknown) {
        lastError = err;
        if (!this.isDuplicateKeyError(err)) {
          throw err;
        }
        this.logger.warn(`tagId ${String(tagId)} collision on insert (attempt ${String(attempt + 1)}); retrying.`);
      }
    }
    this.logger.error('Failed to allocate a unique tagId after retries', lastError as Error);
    throw new ConflictException(
      'Không thể cấp phát mã AprilTag sau nhiều lần thử. Vui lòng thử lại.',
    );
  }

  async findAll(): Promise<Package[]> {
    return this.packageRepository.findAll();
  }

  async findAllPaginated(pagination: PaginationQueryDto): Promise<PaginatedResponseDto<Package>> {
    const { items, total } = await this.packageRepository.findAllPaginated(pagination);
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 10;

    const meta: PaginationMeta = {
      total,
      page,
      limit,
      hasNext: page * limit < total,
    };

    return { items, meta };
  }

  async findById(id: string): Promise<Package> {
    const found = await this.packageRepository.findById(id);
    if (!found) {
      throw new NotFoundException(`Không tìm thấy package với id "${id}"`);
    }
    return found;
  }

  async update(id: string, dto: UpdatePackageDto): Promise<Package> {
    const updated = await this.packageRepository.update(id, dto);
    if (!updated) {
      throw new NotFoundException(`Không tìm thấy package với id "${id}"`);
    }
    this.eventsGateway.emitPackageUpdated(updated);
    return updated;
  }

  async remove(id: string): Promise<void> {
    const found = await this.findById(id);
    await this.packageRepository.remove(found._id);
    this.eventsGateway.emitPackageDeleted(found._id);
  }

  async changeStatus(id: string, nextStatus: PackageStatus): Promise<Package> {
    const pkg = await this.findById(id);
    if (pkg.status === nextStatus) {
      return pkg;
    }

    let nextTagId: number | null = pkg.tagId;
    let nextZoneCode: PackageZone | null = pkg.zoneCode;
    if (nextStatus === PackageStatus.FINISHED) {
      nextTagId = null;
      nextZoneCode = null;
    } else if (pkg.status === PackageStatus.FINISHED) {
      nextTagId = await this.pickLowestFreeTagId();
    }

    const updated = await this.applyStatusUpdate(pkg._id, nextStatus, nextTagId, pkg.tagId, nextZoneCode);
    this.eventsGateway.emitPackageUpdated(updated);
    return updated;
  }

  async markFinished(id: string): Promise<Package | null> {
    const found = await this.packageRepository.findById(id);
    if (!found) {
      return null;
    }
    if (found.status === PackageStatus.FINISHED) {
      return found;
    }

    const updated = await this.applyStatusUpdate(
      found._id,
      PackageStatus.FINISHED,
      null,
      found.tagId,
      null,
    );
    this.eventsGateway.emitPackageUpdated(updated);
    return updated;
  }

  async assignZone(id: string, zoneCode: PackageZone | null): Promise<Package> {
    const pkg = await this.findById(id);
    if (pkg.status === PackageStatus.FINISHED) {
      throw new BadRequestException(
        'Không thể gán zone cho package đã hoàn thành. Vui lòng đặt lại trạng thái trước.',
      );
    }

    const updated = await this.packageRepository.assignZone(id, zoneCode);
    if (!updated) {
      throw new NotFoundException(`Không tìm thấy package với id "${id}"`);
    }
    this.eventsGateway.emitPackageUpdated(updated);
    return updated;
  }

  async getStats(): Promise<PackageStatsResponseDto> {
    return this.packageRepository.getActiveStats();
  }

  private async pickLowestFreeTagId(): Promise<number> {
    for (let attempt = 0; attempt < PackageService.ALLOCATE_RETRIES; attempt++) {
      const taken = new Set(await this.packageRepository.findAllocatedTagIds());
      for (let id = PackageService.TAG_ID_MIN; id <= PackageService.TAG_ID_MAX; id++) {
        if (!taken.has(id)) {
          return id;
        }
      }
      throw new ConflictException(
        'Đã hết mã AprilTag khả dụng (0–586). Vui lòng đánh dấu một số kiện hàng là FINISHED để giải phóng mã.',
      );
    }
    throw new ConflictException(
      'Không thể cấp phát mã AprilTag sau nhiều lần thử. Vui lòng thử lại.',
    );
  }

  private async applyStatusUpdate(
    id: string,
    status: PackageStatus,
    tagId: number | null,
    previousTagId: number | null,
    zoneCode: PackageZone | null,
  ): Promise<Package> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < PackageService.ALLOCATE_RETRIES; attempt++) {
      try {
        const updated = await this.packageRepository.update(id, { status, tagId });
        if (!updated) {
          throw new NotFoundException(`Không tìm thấy package với id "${id}"`);
        }
        const withZone = await this.packageRepository.assignZone(updated._id, zoneCode);
        return withZone ?? updated;
      } catch (err: unknown) {
        lastError = err;
        if (!this.isDuplicateKeyError(err) || tagId === null || tagId === previousTagId) {
          throw err;
        }
        this.logger.warn(
          `tagId ${String(tagId)} collision on status update (attempt ${String(attempt + 1)}); retrying.`,
        );
        const retryTagId = await this.pickLowestFreeTagId();
        tagId = retryTagId;
      }
    }
    this.logger.error('Failed to apply status update after retries', lastError as Error);
    throw new BadRequestException(
      'Không thể cập nhật trạng thái package sau nhiều lần thử. Vui lòng thử lại.',
    );
  }

  private isDuplicateKeyError(err: unknown): boolean {
    if (!err || typeof err !== 'object') {
      return false;
    }
    const code = (err as { code?: number }).code;
    return code === PackageService.DUPLICATE_KEY_ERROR_CODE;
  }
}
