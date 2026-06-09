# Plan B: Job Entity + Robot Namespace (Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create Job entity (Mongoose + endpoints), RobotGateway (Socket.io `/robot` namespace), and rewire shelf move to return 202 + dispatch job.

**Architecture:** JobModule (schema, service, controller) + RobotModule (Socket.io gateway, robot service). ShelfController's `movePackage` calls `JobService.dispatchMove()` creating a Job and emitting `job:dispatch` to `/robot` namespace.

**Tech Stack:** NestJS, Mongoose, Socket.io.

**Spec:** `docs/superpowers/specs/2026-06-09-auth-job-brain-wiring-design.md` §3

---

### Task B1: Job schema

**Files:**
- Create: `apps/api/src/modules/job/job.schema.ts`

- [ ] **Step 1: Create Job schema**

File: `apps/api/src/modules/job/job.schema.ts`

```typescript
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { HydratedDocument } from 'mongoose';

export type JobDocument = HydratedDocument<Job>;

export enum JobStatus {
  DISPATCHED = 'DISPATCHED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Schema({ timestamps: true, versionKey: false })
export class Job {
  _id!: string;

  @Prop({ type: Types.ObjectId, ref: 'Package', required: true })
  packageId!: Types.ObjectId;

  @Prop({ required: true })
  fromSlotCode!: string;

  @Prop({ required: true })
  toSlotCode!: string;

  @Prop({ type: String, enum: JobStatus, default: JobStatus.DISPATCHED })
  status!: JobStatus;
}

export const JobSchema = SchemaFactory.createForClass(Job);
JobSchema.index({ createdAt: -1 });
```

- [ ] **Step 2: Create dispatch-move DTO**

File: `apps/api/src/modules/job/dto/dispatch-move.dto.ts`

```typescript
import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DispatchMoveDto {
  @ApiProperty({ example: 'S1A1' })
  @IsString()
  @IsNotEmpty()
  fromSlotCode!: string;

  @ApiProperty({ example: 'S2C3' })
  @IsString()
  @IsNotEmpty()
  toSlotCode!: string;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/job/
git commit -m "feat(api): add Job schema and dispatch-move DTO"
```

---

### Task B2: Job service

**Files:**
- Create: `apps/api/src/modules/job/job.service.ts`

- [ ] **Step 1: Create job service**

File: `apps/api/src/modules/job/job.service.ts`

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job, JobDocument, JobStatus } from './job.schema';
import { DispatchMoveDto } from './dto/dispatch-move.dto';
import { ShelfRepository } from '../shelf/shelf-repository';
import { SlotStatus } from '../shelf/interfaces/shelf-slot.interface';
import { RobotGateway } from '../robot/robot.gateway';
import { EventsGateway } from '../../gateway/events-gateway';

@Injectable()
export class JobService {
  constructor(
    @InjectModel(Job.name) private jobModel: Model<JobDocument>,
    private shelfRepository: ShelfRepository,
    private robotGateway: RobotGateway,
    private eventsGateway: EventsGateway,
  ) {}

  async dispatchMove(dto: DispatchMoveDto): Promise<{ jobId: string }> {
    const fromSlot = await this.shelfRepository.findSlotByCode(dto.fromSlotCode);
    if (!fromSlot) throw new NotFoundException(`Không tìm thấy vị trí "${dto.fromSlotCode}"`);
    if (fromSlot.status === SlotStatus.AVAILABLE || !fromSlot.packageId)
      throw new NotFoundException(`Vị trí "${dto.fromSlotCode}" không có hàng hóa`);

    const toSlot = await this.shelfRepository.findSlotByCode(dto.toSlotCode);
    if (!toSlot) throw new NotFoundException(`Không tìm thấy vị trí đích "${dto.toSlotCode}"`);
    if (toSlot.status === SlotStatus.OCCUPIED)
      throw new NotFoundException(`Vị trí đích "${dto.toSlotCode}" đã có hàng hóa`);

    const packageId = fromSlot.packageId;

    // Reserve both slots
    await this.shelfRepository.updateSlotStatus(dto.fromSlotCode, SlotStatus.RESERVED);
    await this.shelfRepository.updateSlotStatus(dto.toSlotCode, SlotStatus.RESERVED);

    // Create job
    const job = await this.jobModel.create({
      packageId,
      fromSlotCode: dto.fromSlotCode,
      toSlotCode: dto.toSlotCode,
    });

    // Emit to brain
    this.robotGateway.dispatchJob(job);

    // Emit to web clients
    this.eventsGateway.emitJobCreated(job);

    return { jobId: job._id };
  }

  async findAll(): Promise<JobDocument[]> {
    return this.jobModel.find().sort({ createdAt: -1 }).lean();
  }

  async findById(id: string): Promise<JobDocument | null> {
    return this.jobModel.findById(id).lean();
  }

  async updateStatus(jobId: string, status: JobStatus): Promise<void> {
    await this.jobModel.findByIdAndUpdate(jobId, { status });
    const job = await this.jobModel.findById(jobId);
    if (job) {
      this.eventsGateway.emitJobUpdated(job);

      // If completed or failed, release slot reservations
      if (status === JobStatus.COMPLETED || status === JobStatus.FAILED) {
        await this.shelfRepository.updateSlotStatus(job.fromSlotCode, SlotStatus.AVAILABLE);
        // For COMPLETED: target slot becomes OCCUPIED by the package
        if (status === JobStatus.COMPLETED) {
          await this.shelfRepository.assignPackageToSlot(job.toSlotCode, job.packageId);
        } else {
          await this.shelfRepository.updateSlotStatus(job.toSlotCode, SlotStatus.AVAILABLE);
        }
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/job/job.service.ts
git commit -m "feat(api): add JobService with dispatchMove, updateStatus, release logic"
```

---

### Task B3: Job controller

**Files:**
- Create: `apps/api/src/modules/job/job.controller.ts`

- [ ] **Step 1: Create job controller**

File: `apps/api/src/modules/job/job.controller.ts`

```typescript
import { Controller, Get, Param, Post, Body } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JobService } from './job.service';
import { DispatchMoveDto } from './dto/dispatch-move.dto';

@ApiTags('Jobs')
@Controller('jobs')
export class JobController {
  constructor(private jobService: JobService) {}

  @Post('dispatch')
  @ApiOperation({ summary: 'Dispatch a move job for the AGV robot' })
  @ApiCreatedResponse({ description: 'Job dispatched, returns jobId' })
  async dispatch(@Body() dto: DispatchMoveDto) {
    return this.jobService.dispatchMove(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all jobs' })
  @ApiOkResponse({ description: 'Array of jobs' })
  async findAll() {
    return this.jobService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get job by ID' })
  @ApiOkResponse({ description: 'Single job' })
  async findById(@Param('id') id: string) {
    return this.jobService.findById(id);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/job/job.controller.ts
git commit -m "feat(api): add job endpoints (GET all, GET by id, POST dispatch)"
```

---

### Task B4: Job module

**Files:**
- Create: `apps/api/src/modules/job/job.module.ts`

- [ ] **Step 1: Create job module**

File: `apps/api/src/modules/job/job.module.ts`

```typescript
import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Job, JobSchema } from './job.schema';
import { JobController } from './job.controller';
import { JobService } from './job.service';
import { ShelfModule } from '../shelf/shelf.module';
import { RobotModule } from '../robot/robot.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Job.name, schema: JobSchema }]),
    forwardRef(() => ShelfModule),
    forwardRef(() => RobotModule),
  ],
  controllers: [JobController],
  providers: [JobService],
  exports: [JobService],
})
export class JobModule {}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/job/job.module.ts
git commit -m "feat(api): add JobModule"
```

---

### Task B5: Robot gateway (Socket.io /robot namespace)

**Files:**
- Create: `apps/api/src/modules/robot/robot.gateway.ts`
- Create: `apps/api/src/modules/robot/robot.service.ts`
- Create: `apps/api/src/modules/robot/robot.module.ts`

- [ ] **Step 1: Create robot service** (manages single brain client)

File: `apps/api/src/modules/robot/robot.service.ts`

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';

@Injectable()
export class RobotService {
  private readonly logger = new Logger(RobotService.name);
  private brainClient: Socket | null = null;
  private brainId: string | null = null;

  registerBrain(client: Socket): boolean {
    if (this.brainClient && this.brainClient.connected) {
      this.logger.warn(`Brain ${client.id} connecting but ${this.brainId} already active — disconnecting old`);
      this.brainClient.disconnect();
    }
    this.brainClient = client;
    this.brainId = client.id;
    this.logger.log(`Brain ${client.id} registered`);
    return true;
  }

  unregisterBrain(clientId: string): void {
    if (this.brainId === clientId) {
      this.logger.log(`Brain ${clientId} unregistered`);
      this.brainClient = null;
      this.brainId = null;
    }
  }

  getBrain(): Socket | null {
    return this.brainClient;
  }

  isBrainConnected(): boolean {
    return this.brainClient !== null && this.brainClient.connected;
  }
}
```

- [ ] **Step 2: Create robot gateway**

File: `apps/api/src/modules/robot/robot.gateway.ts`

```typescript
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RobotService } from './robot.service';
import { JobService } from '../job/job.service';
import { Job, JobStatus } from '../job/job.schema';

@WebSocketGateway({
  namespace: '/robot',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class RobotGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RobotGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private configService: ConfigService,
    private robotService: RobotService,
    private jobService: JobService,
  ) {}

  handleConnection(client: Socket): void {
    const token = client.handshake.auth?.token;
    const expected = this.configService.get<string>('ROBOT_BRAIN_TOKEN');
    if (!token || token !== expected) {
      this.logger.warn(`Rejected connection from ${client.id} — invalid token`);
      client.disconnect();
      return;
    }
    this.robotService.registerBrain(client);
    this.logger.log(`Brain connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.robotService.unregisterBrain(client.id);
    this.logger.log(`Brain disconnected: ${client.id}`);
  }

  @SubscribeMessage('job:status')
  async handleJobStatus(
    client: Socket,
    payload: { jobId: string; status: JobStatus },
  ): Promise<void> {
    this.logger.log(`job:status from brain — ${payload.jobId} → ${payload.status}`);
    await this.jobService.updateStatus(payload.jobId, payload.status);
  }

  dispatchJob(job: Job): void {
    if (!this.robotService.isBrainConnected()) {
      this.logger.warn('Cannot dispatch job — brain not connected');
      return;
    }
    this.server.emit('job:dispatch', {
      _id: job._id,
      packageId: job.packageId,
      fromSlotCode: job.fromSlotCode,
      toSlotCode: job.toSlotCode,
    });
  }
}
```

- [ ] **Step 3: Create robot module**

File: `apps/api/src/modules/robot/robot.module.ts`

```typescript
import { Module, forwardRef } from '@nestjs/common';
import { RobotGateway } from './robot.gateway';
import { RobotService } from './robot.service';
import { JobModule } from '../job/job.module';

@Module({
  imports: [forwardRef(() => JobModule)],
  providers: [RobotGateway, RobotService],
  exports: [RobotGateway, RobotService],
})
export class RobotModule {}
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/robot/
git commit -m "feat(api): add RobotGateway with /robot namespace + brain management"
```

---

### Task B6: Wire RobotModule + JobModule into AppModule

**Files:**
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Register both modules**

Find the `imports` array in `app.module.ts` and add:

```typescript
imports: [
  ...
  JobModule,
  RobotModule,
  ...
]
```

- [ ] **Step 2: Verify build**

```bash
cd apps/api && yarn build
```

Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/app.module.ts
git commit -m "feat(api): register JobModule and RobotModule in AppModule"
```

---

### Task B7: Update ShelfController — return 202 + call JobService

**Files:**
- Modify: `apps/api/src/modules/shelf/shelf-controller.ts`
- Modify: `apps/api/src/modules/shelf/shelf-service.ts`

- [ ] **Step 1: Update shelf controller to return 202**

File: `apps/api/src/modules/shelf/shelf-controller.ts`

Change the `movePackage` method from calling `shelfService.movePackage(dto)` to calling `jobService.dispatchMove(dto)`:

```typescript
import { JobService } from '../job/job.service';

// In constructor:
constructor(
  private readonly shelfService: ShelfService,
  private readonly shelfRepository: ShelfRepository,
  private readonly jobService: JobService,
  ...
) {}

@Put(':slotCode/package')
@HttpCode(HttpStatus.ACCEPTED)
@ApiOperation({ summary: 'Move a package via AGV robot (returns jobId)' })
@ApiResponse({ status: 202, description: 'Job dispatched' })
@ApiResponse({ status: 400, description: 'Invalid move' })
async movePackage(
  @Param('slotCode') slotCode: string,
  @Body() dto: MovePackageDto,
): Promise<{ jobId: string }> {
  return this.jobService.dispatchMove({
    fromSlotCode: slotCode.toUpperCase(),
    toSlotCode: dto.targetSlotCode.toUpperCase(),
  });
}
```

Note: The old `MovePackageDto` has `targetSlotCode` — map it to `DispatchMoveDto`'s fields.

- [ ] **Step 2: Add Status slot update methods to ShelfRepository**

If `updateSlotStatus` doesn't exist on `ShelfRepository`, add it:

```typescript
async updateSlotStatus(slotCode: string, status: SlotStatus): Promise<void> {
  await this.slotModel.updateOne({ slotCode }, { status });
}
```

- [ ] **Step 3: Verify build**

```bash
cd apps/api && yarn build
```

Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shelf/
git commit -m "feat(api): rewire shelf move to JobService with 202 response"
```

---

### Task B8: Update EventsGateway — add job events

**Files:**
- Modify: `apps/api/src/gateway/events-gateway.ts`

- [ ] **Step 1: Add job event methods**

File: `apps/api/src/gateway/events-gateway.ts`

Add after the existing methods:

```typescript
emitJobCreated(data: unknown): void {
  this.server.emit('job:created', data);
}

emitJobUpdated(data: unknown): void {
  this.server.emit('job:updated', data);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/gateway/events-gateway.ts
git commit -m "feat(api): add job:created and job:updated events to EventsGateway"
```

---

### Task B9: Add ROBOT_BRAIN_TOKEN to deploy.yml and env docs

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `apps/api/CLAUDE.md`

- [ ] **Step 1: Add to deploy.yml**

Find the `deploy-api` job env section and add:

```yaml
ROBOT_BRAIN_TOKEN: ${{ secrets.ROBOT_BRAIN_TOKEN }}
```

- [ ] **Step 2: Document in CLAUDE.md**

Add to `apps/api/CLAUDE.md`:

```
| `ROBOT_BRAIN_TOKEN` | — | Shared secret for brain↔API Socket.io auth. Generate with `openssl rand -hex 32`. |
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml apps/api/CLAUDE.md
git commit -m "feat(api): add ROBOT_BRAIN_TOKEN to deploy and docs"
```
