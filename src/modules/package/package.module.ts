import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PackageController } from './package-controller';
import { PackageRepositoryProvider } from './package-repository';
import { PackageService } from './package-service';
import { Package, PackageSchema } from './schemas/package.schema';
import { ShelfModule } from '../shelf/shelf.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Package.name, schema: PackageSchema }]),
    forwardRef(() => ShelfModule),
  ],
  controllers: [PackageController],
  providers: [PackageService, PackageRepositoryProvider],
  exports: [PackageService],
})
export class PackageModule {}
