import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PackageModule } from '../package/package.module';
import { Shelf, ShelfSchema } from './schemas/shelf.schema';
import { ShelfSlot, ShelfSlotSchema } from './schemas/shelf-slot.schema';
import { ShelfController } from './shelf-controller';
import { ShelfRepository, ShelfRepositoryProvider } from './shelf-repository';
import { ShelfService } from './shelf-service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Shelf.name, schema: ShelfSchema },
      { name: ShelfSlot.name, schema: ShelfSlotSchema },
    ]),
    forwardRef(() => PackageModule),
  ],
  controllers: [ShelfController],
  providers: [ShelfService, ShelfRepository, ShelfRepositoryProvider],
  exports: [ShelfService],
})
export class ShelfModule {}
