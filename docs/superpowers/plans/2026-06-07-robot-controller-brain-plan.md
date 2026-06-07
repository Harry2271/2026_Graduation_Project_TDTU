# Robot Controller (Brain) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Pi 5 brain controller that autonomously maps a warehouse, accepts delivery jobs from the web UI, navigates via Nav2, identifies shelves by AprilTag, and dispatches motor commands to the ESP32. The brain is fully unit-testable before the ESP32 firmware is implemented.

**Architecture:** A new `brain_node.py` ROS 2 node owns the high-level state machine. It talks to Nav2 for path planning, to a new `esp32_bridge.py` over UART (abstract interface, with a `FakeEsp32Bridge` for tests), to a new `april_tag_node.py` for vision, and to the NestJS API as a Socket.io client on a new `/robot` namespace. The existing `map_manager_node.py` and `web_bridge.py` are untouched.

**Tech Stack:** Python 3 (rclpy, asyncio, pyserial-asyncio, pupil-apriltags, OpenCV), ROS 2 Jazzy, Nav2 (online_async planning + DWA local planner), NestJS 11 + Socket.io, Next.js 16, MongoDB.

**Phasing:** This plan covers **Phases 0-2** of the rollout in the spec (the pre-merge-gate phases). Phases 3-7 will be separate plan files written when each phase is ready to start.

**Spec:** `docs/superpowers/specs/2026-06-07-robot-controller-brain-design.md`

---

## File Structure

### Controller (`services/robot/`)

| File | Responsibility |
|---|---|
| `src/my_robot_controller/my_robot_controller/esp32_bridge.py` | Pi<->ESP32 UART wrapper. `Esp32Bridge` Protocol, `RealEsp32Bridge` (pyserial-asyncio), `FakeEsp32Bridge` (in-memory, for tests). |
| `src/my_robot_controller/my_robot_controller/brain_node.py` | High-level state machine. Subscribes to `/cmd_vel` (Nav2), `/mapping_status` (map_manager), `/detected_tags` (april_tag_node). Connects to API as Socket.io client. |
| `src/my_robot_controller/my_robot_controller/april_tag_node.py` | Camera reader + AprilTag detector. Publishes `/detected_tags` (list of `{tag_id, x, y, theta}` in robot frame). |
| `launch/nav2_launch.py` | Nav2 bringup. Includes AMCL + planner + DWA. |
| `config/nav2_params.yaml` | Nav2 tuning parameters. |
| `setup.py` | Register `brain` and `april_tag_node` entry points. |
| `deploy.sh` | Start 3 new PM2 processes. |
| `install-pi.sh` | Install `nav2-bringup`, `nav2-simple-commander`, `pupil-apriltags`, `pyserial-asyncio`. |
| `tests/test_esp32_bridge.py` | Unit tests against `FakeEsp32Bridge`. |

### API (`apps/api/src/modules/`)

| File | Responsibility |
|---|---|
| `robot/robot.gateway.ts` | Socket.io `/robot` namespace, brain auth via `ROBOT_BRAIN_TOKEN`. |
| `robot/robot.service.ts` | Holds the single brain client connection, forwards events to `JobService`. |
| `job/job.schema.ts` | Mongoose `Job` schema. |
| `job/job-service.ts` | Job CRUD, `dispatchMove()`, auto-cleanup creation. |
| `job/job-controller.ts` | `GET /jobs`, `GET /jobs/:id`. |
| `shelf/schemas/shelf-slot.schema.ts` | UPDATE: add `slotX, slotY, aprilTagId, facingTheta`; extend `SlotStatus` enum with `RESERVED, TRANSIT`. |
| `shelf/shelf-service.ts` | UPDATE: `assignCoordinates()`, `assignAprilTag()`. |
| `shelf/shelf-controller.ts` | UPDATE: `PUT /shelves/:slotCode/coordinates`, `PUT /shelves/coordinates/batch`. |
| `package/schemas/package.schema.ts` | UPDATE: add `targetSlotCode, sourceSlotCode`. |
| `maps/maps.controller.ts` | `GET /api/robot/map-image` static file serve. |
| `app.module.ts` | UPDATE: import `JobModule, MapsModule, RobotModule`. |

### Web (`apps/web/src/app/`)

| File | Responsibility |
|---|---|
| `calibrate/page.tsx` | One-time warehouse setup. |
| `calibrate/CalibrateClient.tsx` | Interactive client component. |
## Phase 0: Skeleton

Goal: Get the file structure in place with empty `main()` functions. No behavior change. After this phase, `colcon build` succeeds, and PM2 can start the 3 new processes (they just do nothing).

### Task 0.1: Register entry points in setup.py

**Files:**
- Modify: `services/robot/src/my_robot_controller/setup.py:32`

- [ ] **Step 1: Open `setup.py` and find the `entry_points` dict**

Open `d:\taiLieuHoc\robot-for-nguyen\services\robot\src\my_robot_controller\setup.py` and locate the `entry_points` block. It should contain a `brain = my_robot_controller.brain_node:main` line (already declared but file is missing) plus the existing `web_bridge` and `map_manager` lines.

- [ ] **Step 2: Add `april_tag_node` entry point**

Add (or verify the line is present):
```python
'april_tag_node = my_robot_controller.april_tag_node:main',
```

The final `entry_points` dict must contain exactly these console_scripts:
```python
entry_points={
    'console_scripts': [
        'web_bridge = my_robot_controller.web_bridge:main',
        'map_manager = my_robot_controller.map_manager_node:main',
        'brain = my_robot_controller.brain_node:main',
        'april_tag_node = my_robot_controller.april_tag_node:main',
    ],
},
```

- [ ] **Step 3: Commit**

```bash
git add services/robot/src/my_robot_controller/setup.py
git commit -m "feat(robot): register brain and april_tag_node entry points"
```

---

### Task 0.2: Create empty brain_node.py skeleton

**Files:**
- Create: `services/robot/src/my_robot_controller/my_robot_controller/brain_node.py`

- [ ] **Step 1: Create the file with a minimal `main()`**

Create `d:\taiLieuHoc\robot-for-nguyen\services\robot\src\my_robot_controller\my_robot_controller\brain_node.py` with this content:

```python
"""Brain controller — high-level state machine for the warehouse robot.

Subscribes to /cmd_vel from Nav2, /mapping_status from map_manager, and
/detected_tags from april_tag_node. Connects to the NestJS API as a
Socket.io client on the /robot namespace.
"""
import rclpy
from rclpy.node import Node


class BrainNode(Node):
    def __init__(self) -> None:
        super().__init__('brain')
        self.get_logger().info('brain_node started (skeleton)')


def main() -> None:
    rclpy.init()
    node = BrainNode()
    rclpy.spin(node)
    rclpy.shutdown()


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Commit**

```bash
git add services/robot/src/my_robot_controller/my_robot_controller/brain_node.py
git commit -m "feat(robot): add brain_node skeleton"
```

---

### Task 0.3: Create empty april_tag_node.py skeleton

**Files:**
- Create: `services/robot/src/my_robot_controller/my_robot_controller/april_tag_node.py`

- [ ] **Step 1: Create the file with a minimal `main()`**

Create `d:\taiLieuHoc\robot-for-nguyen\services\robot\src\my_robot_controller\my_robot_controller\april_tag_node.py` with this content:

```python
"""AprilTag detector — reads from /dev/video0 and publishes /detected_tags."""
import rclpy
from rclpy.node import Node


class AprilTagNode(Node):
    def __init__(self) -> None:
        super().__init__('april_tag_node')
        self.get_logger().info('april_tag_node started (skeleton)')


def main() -> None:
    rclpy.init()
    node = AprilTagNode()
    rclpy.spin(node)
    rclpy.shutdown()


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Commit**

```bash
git add services/robot/src/my_robot_controller/my_robot_controller/april_tag_node.py
git commit -m "feat(robot): add april_tag_node skeleton"
```

---

### Task 0.4: Create empty nav2_launch.py

**Files:**
- Create: `services/robot/src/my_robot_controller/launch/nav2_launch.py`

- [ ] **Step 1: Create the file**

Create `d:\taiLieuHoc\robot-for-nguyen\services\robot\src\my_robot_controller\launch\nav2_launch.py` with this content:

```python
"""Nav2 bringup. Stub for Phase 0; will be filled in at Phase 3."""
from launch import LaunchDescription


def generate_launch_description() -> LaunchDescription:
    return LaunchDescription([])
```

- [ ] **Step 2: Commit**

```bash
git add services/robot/src/my_robot_controller/launch/nav2_launch.py
git commit -m "feat(robot): add nav2_launch stub"
```

---

### Task 0.5: Create empty nav2_params.yaml

**Files:**
- Create: `services/robot/src/my_robot_controller/config/nav2_params.yaml`

- [ ] **Step 1: Create the file with placeholder**

Create `d:\taiLieuHoc\robot-for-nguyen\services\robot\src\my_robot_controller\config\nav2_params.yaml` with this content:

```yaml
# Nav2 parameters — placeholder. Real values in Phase 3.
amcl:
  ros__parameters:
    use_sim_time: false
```

- [ ] **Step 2: Commit**

```bash
git add services/robot/src/my_robot_controller/config/nav2_params.yaml
git commit -m "feat(robot): add nav2_params placeholder"
```

---

### Task 0.6: Update deploy.sh to register the 3 new PM2 processes

**Files:**
- Modify: `services/robot/deploy.sh`

- [ ] **Step 1: Read the current deploy.sh**

Open `d:\taiLieuHoc\robot-for-nguyen\services\robot\deploy.sh` and find the section that starts the 4 existing PM2 processes. It uses `pm2 start` with a script string ending in `ros2 launch my_robot_controller <file>.py` or `ros2 run my_robot_controller <entry_point>`.

- [ ] **Step 2: Add 3 new PM2 starts after the existing 4**

Add these three `pm2 start` lines after the existing 4:

```bash
pm2 start --name nexus-robot-nav2 --interpreter bash --cwd "$HOME/robot_ws" -- \
  bash -c "source /opt/ros/jazzy/setup.bash && source install/setup.bash && ros2 launch my_robot_controller nav2_launch.py"

pm2 start --name nexus-robot-brain --interpreter bash --cwd "$HOME/robot_ws" -- \
  bash -c "source /opt/ros/jazzy/setup.bash && source install/setup.bash && ros2 run my_robot_controller brain"

pm2 start --name nexus-robot-vision --interpreter bash --cwd "$HOME/robot_ws" -- \
  bash -c "source /opt/ros/jazzy/setup.bash && source install/setup.bash && ros2 run my_robot_controller april_tag_node"
```

- [ ] **Step 3: Add `pm2 save` at the end if not already present**

After the new `pm2 start` calls, ensure `pm2 save` is called (it should already be there from the existing 4 processes; just verify it's after all 7).

- [ ] **Step 4: Commit**

```bash
git add services/robot/deploy.sh
git commit -m "feat(robot): start brain, nav2, vision in deploy.sh"
```

---

### Task 0.7: Build and verify

- [ ] **Step 1: Build the ROS 2 package**

Run from the Pi (or in a ROS 2 Jazzy container):
```bash
cd ~/robot_ws
colcon build --merge-install --executor sequential --packages-select my_robot_controller
```
Expected: `Starting >>> my_robot_controller`, `Finished >>> my_robot_controller`, no errors.

- [ ] **Step 2: Verify the new executables are findable**

```bash
source install/setup.bash
## Phase 1: Data Model + Calibrate

Goal: Add `slotX, slotY, aprilTagId, facingTheta` to `ShelfSlot`; add `RESERVED, TRANSIT` to `SlotStatus`; add `targetSlotCode, sourceSlotCode` to `Package`; add the new `PUT /shelves/:slotCode/coordinates` and `PUT /shelves/coordinates/batch` endpoints; build the Calibrate page. **No robot involvement in this phase** — the operator can pre-seed the warehouse.

### Task 1.1: Update ShelfSlot schema

**Files:**
- Modify: `apps/api/src/modules/shelf/schemas/shelf-slot.schema.ts`

- [ ] **Step 1: Read the current schema**

Open `d:\taiLieuHoc\robot-for-nguyen\apps\api\src\modules\shelf\schemas\shelf-slot.schema.ts` and find the `@Schema()` class definition.

- [ ] **Step 2: Add 4 new properties to the class**

Inside the `ShelfSlot` class, after the existing `packageId` property, add:

```typescript
  @Prop({ required: false })
  slotX?: number;

  @Prop({ required: false })
  slotY?: number;

  @Prop({ required: false, default: null })
  facingTheta?: number;

  @Prop({ required: false, default: null })
  aprilTagId?: number;
```

- [ ] **Step 3: Update the SlotStatus enum**

Find the `SlotStatus` enum in the same file. It currently has:
```typescript
export enum SlotStatus {
  AVAILABLE = 'AVAILABLE',
  OCCUPIED = 'OCCUPIED',
}
```

Change it to:
```typescript
export enum SlotStatus {
  AVAILABLE = 'AVAILABLE',
  OCCUPIED = 'OCCUPIED',
  RESERVED = 'RESERVED',
  TRANSIT = 'TRANSIT',
}
```

- [ ] **Step 4: Build the API to verify**

```bash
cd apps/api
yarn build
```
Expected: builds without TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shelf/schemas/shelf-slot.schema.ts
git commit -m "feat(api): add slotX, slotY, aprilTagId, facingTheta to ShelfSlot"
```

---

### Task 1.2: Add findByAprilTagId to shelf repository

**Files:**
- Modify: `apps/api/src/modules/shelf/interfaces/shelf-repository.interface.ts`
- Modify: `apps/api/src/modules/shelf/shelf-repository.ts`

- [ ] **Step 1: Add the method to the interface**

Open `apps/api/src/modules/shelf/interfaces/shelf-repository.interface.ts`. Add a new method signature inside the `IShelfRepository` interface:

```typescript
  findByAprilTagId(aprilTagId: number): Promise<ShelfSlot | null>;
```

- [ ] **Step 2: Implement the method in the repository**

Open `apps/api/src/modules/shelf/shelf-repository.ts`. Find the class body and add (adjust the Mongoose call to match the existing pattern in this file — likely using `.exec()` or `.lean()`):

```typescript
  async findByAprilTagId(aprilTagId: number): Promise<ShelfSlot | null> {
    const doc = await this.shelfSlotModel.findOne({ aprilTagId }).exec();
    return doc ? doc.toObject() : null;
  }
```

- [ ] **Step 3: Build**

```bash
cd apps/api
yarn build
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shelf/
git commit -m "feat(api): add findByAprilTagId to shelf repository"
```

---

### Task 1.3: Add assignCoordinates, assignAprilTag, findByAprilTagId to ShelfService

**Files:**
- Modify: `apps/api/src/modules/shelf/interfaces/shelf-service.interface.ts`
- Modify: `apps/api/src/modules/shelf/shelf-service.ts`
- Modify: `apps/api/src/modules/shelf/interfaces/shelf-repository.interface.ts`
- Modify: `apps/api/src/modules/shelf/shelf-repository.ts`

- [ ] **Step 1: Add service method signatures**

In `apps/api/src/modules/shelf/interfaces/shelf-service.interface.ts`, add:
```typescript
  assignCoordinates(slotCode: string, slotX: number, slotY: number, facingTheta: number | null): Promise<ShelfSlot>;
  assignAprilTag(slotCode: string, aprilTagId: number): Promise<ShelfSlot>;
  findByAprilTagId(aprilTagId: number): Promise<ShelfSlot | null>;
  assignCoordinatesBatch(entries: Array<{ slotCode: string; slotX: number; slotY: number; facingTheta: number | null }>): Promise<ShelfSlot[]>;
```

- [ ] **Step 2: Add missing repository method signatures**

In `apps/api/src/modules/shelf/interfaces/shelf-repository.interface.ts`, add:
```typescript
  updateCoordinates(slotCode: string, slotX: number, slotY: number, facingTheta: number | null): Promise<ShelfSlot | null>;
  assignAprilTag(slotCode: string, aprilTagId: number): Promise<ShelfSlot | null>;
```

- [ ] **Step 3: Implement repository methods**

In `apps/api/src/modules/shelf/shelf-repository.ts`, add the implementations (follow the existing `assignPackageToSlot` pattern):

```typescript
  async updateCoordinates(
    slotCode: string,
    slotX: number,
    slotY: number,
    facingTheta: number | null,
  ): Promise<ShelfSlot | null> {
    const doc = await this.shelfSlotModel
      .findOneAndUpdate(
        { code: slotCode },
        { $set: { slotX, slotY, facingTheta } },
        { new: true },
      )
      .exec();
    return doc ? doc.toObject() : null;
  }

  async assignAprilTag(slotCode: string, aprilTagId: number): Promise<ShelfSlot | null> {
    const doc = await this.shelfSlotModel
      .findOneAndUpdate(
        { code: slotCode },
        { $set: { aprilTagId } },
        { new: true },
      )
      .exec();
    return doc ? doc.toObject() : null;
  }
```

- [ ] **Step 4: Implement service methods**

In `apps/api/src/modules/shelf/shelf-service.ts`, add inside the class:

```typescript
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
      throw new BadRequestException(`aprilTagId ${aprilTagId} đã được gán cho vị trí "${conflict.code}"`);
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
    entries: Array<{ slotCode: string; slotX: number; slotY: number; facingTheta: number | null }>,
  ): Promise<ShelfSlot[]> {
    const updated: ShelfSlot[] = [];
    for (const entry of entries) {
      const slot = await this.assignCoordinates(entry.slotCode, entry.slotX, entry.slotY, entry.facingTheta);
      updated.push(slot);
    }
    return updated;
  }
```

- [ ] **Step 5: Build**

```bash
cd apps/api
yarn build
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shelf/
git commit -m "feat(api): add assignCoordinates, assignAprilTag, findByAprilTagId"
```

---

### Task 1.4: Add PUT /shelves/:slotCode/coordinates endpoint

**Files:**
- Modify: `apps/api/src/modules/shelf/shelf-controller.ts`
- Create: `apps/api/src/modules/shelf/dto/assign-coordinates.dto.ts`

- [ ] **Step 1: Create the DTO**

Create `apps/api/src/modules/shelf/dto/assign-coordinates.dto.ts`:

```typescript
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class AssignCoordinatesDto {
  @IsNumber()
  @Min(-100)
  @Max(100)
  slotX!: number;

  @IsNumber()
  @Min(-100)
  @Max(100)
  slotY!: number;

  @IsOptional()
  @IsNumber()
  @Min(-Math.PI)
  @Max(Math.PI)
  facingTheta?: number;
}
```

- [ ] **Step 2: Add the controller method**

Open `apps/api/src/modules/shelf/shelf-controller.ts`. Add a new import for `AssignCoordinatesDto`. Add this method to the `ShelfController` class (note: it must come **after** the `coordinates/batch` route, which is added in Task 1.5):

```typescript
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
```

- [ ] **Step 3: Build**

```bash
cd apps/api
yarn build
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shelf/
git commit -m "feat(api): PUT /shelves/:slotCode/coordinates"
```

---

### Task 1.5: Add PUT /shelves/coordinates/batch endpoint

**Files:**
- Modify: `apps/api/src/modules/shelf/shelf-controller.ts`
- Create: `apps/api/src/modules/shelf/dto/assign-coordinates-batch.dto.ts`

- [ ] **Step 1: Create the batch DTO**

Create `apps/api/src/modules/shelf/dto/assign-coordinates-batch.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

export class CoordinatesBatchEntryDto {
  @IsString()
  slotCode!: string;

  @IsNumber()
  @Min(-100)
  @Max(100)
  slotX!: number;

  @IsNumber()
  @Min(-100)
  @Max(100)
  slotY!: number;

  @IsOptional()
  @IsNumber()
  @Min(-Math.PI)
  @Max(Math.PI)
  facingTheta?: number;
}

export class AssignCoordinatesBatchDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CoordinatesBatchEntryDto)
  entries!: CoordinatesBatchEntryDto[];
}
```

- [ ] **Step 2: Add the controller method**

In `apps/api/src/modules/shelf/shelf-controller.ts`, add (must come **before** the `:slotCode/coordinates` route to avoid Express treating `coordinates` as a slotCode):

```typescript
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
```

- [ ] **Step 3: Build**

```bash
cd apps/api
yarn build
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shelf/
git commit -m "feat(api): PUT /shelves/coordinates/batch"
```

---

### Task 1.6: Update Package schema with targetSlotCode and sourceSlotCode

**Files:**
- Modify: `apps/api/src/modules/package/schemas/package.schema.ts`

- [ ] **Step 1: Add the two fields**

Open `apps/api/src/modules/package/schemas/package.schema.ts`. After the existing `tagId` field, add:

```typescript
  @Prop({ required: false, default: null })
  targetSlotCode?: string;

  @Prop({ required: false, default: null })
  sourceSlotCode?: string;
```

- [ ] **Step 2: Build**

```bash
cd apps/api
yarn build
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/package/schemas/package.schema.ts
git commit -m "feat(api): add targetSlotCode, sourceSlotCode to Package"
```

---

### Task 1.7: Create the Maps module

**Files:**
- Create: `apps/api/src/modules/maps/maps.controller.ts`
- Create: `apps/api/src/modules/maps/maps.module.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Create MapsController**

Create `apps/api/src/modules/maps/maps.controller.ts`:

```typescript
import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const MAPS_DIR = process.env.MAPS_DIR ?? '/home/pi/robot_ws/maps';

@Controller('api/robot')
export class MapsController {
  @Get('map-image')
  getLatestMap(@Res() res: Response): void {
    const candidates = ['latest.pgm', 'map.pgm'];
    for (const name of candidates) {
      const full = path.join(MAPS_DIR, name);
      if (fs.existsSync(full)) {
        res.setHeader('Content-Type', 'image/x-portable-graymap');
        fs.createReadStream(full).pipe(res);
        return;
      }
    }
    throw new NotFoundException('No map found');
  }

  @Get('map-image/:name')
  getNamedMap(@Param('name') name: string, @Res() res: Response): void {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new NotFoundException('Invalid map name');
    }
    const full = path.join(MAPS_DIR, name);
    if (!fs.existsSync(full)) {
      throw new NotFoundException(`Map ${name} not found`);
    }
    res.setHeader('Content-Type', 'image/x-portable-graymap');
    fs.createReadStream(full).pipe(res);
  }
}
```

- [ ] **Step 2: Create MapsModule**

Create `apps/api/src/modules/maps/maps.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { MapsController } from './maps.controller';

@Module({
  controllers: [MapsController],
})
export class MapsModule {}
```

- [ ] **Step 3: Register MapsModule in AppModule**

Open `apps/api/src/app.module.ts`. Add to the `imports` array (keep alphabetical if other modules follow that convention):

```typescript
import { MapsModule } from './modules/maps/maps.module';

@Module({
  imports: [
    // ... existing imports
    MapsModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 4: Build**

```bash
cd apps/api
yarn build
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/maps/ apps/api/src/app.module.ts
git commit -m "feat(api): add Maps module to serve SLAM map images"
```

---

### Task 1.8: Build the Calibrate page (web)

**Files:**
- Create: `apps/web/src/app/calibrate/page.tsx`
- Create: `apps/web/src/app/calibrate/CalibrateClient.tsx`

- [ ] **Step 1: Create the page entry**

Create `apps/web/src/app/calibrate/page.tsx`:

```typescript
import CalibrateClient from './CalibrateClient';

export default function CalibratePage() {
  return <CalibrateClient />;
}
```

- [ ] **Step 2: Create the client component**

Create `apps/web/src/app/calibrate/CalibrateClient.tsx`:

```typescript
'use client';

import { useEffect, useState, useRef, useCallback } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:5000';
const MAPS_URL = `${API_BASE}/api/robot/map-image`;

interface ShelfSlot {
  _id: string;
  code: string;
  shelf: string;
  row: string;
  column: number;
  status: string;
  packageId: string | null;
  slotX?: number;
  slotY?: number;
  aprilTagId?: number;
  facingTheta?: number;
}

export default function CalibrateClient() {
  const [slots, setSlots] = useState<ShelfSlot[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    fetch(`${API_BASE}/shelves/slots`)
      .then((r) => r.json())
      .then((data) => setSlots(data));
  }, []);

  const onImageLoad = useCallback(() => {
    if (imgRef.current) {
      setImageSize({ w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight });
    }
  }, []);

  const onMapClick = useCallback(
    async (e: React.MouseEvent<HTMLImageElement>) => {
      if (!selectedCode || !imgRef.current) return;
      const rect = imgRef.current.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const METER_SCALE = 40 / imageSize.w;
      const slotX = px * METER_SCALE - 20;
      const slotY = 20 - py * METER_SCALE;

      const res = await fetch(`${API_BASE}/shelves/${selectedCode}/coordinates`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotX, slotY }),
      });
      if (res.ok) {
        const updated: ShelfSlot = await res.json();
        setSlots((prev) => prev.map((s) => (s.code === selectedCode ? updated : s)));
      } else {
        const err = await res.json();
        alert(err.message ?? 'Lỗi khi lưu tọa độ');
      }
    },
    [selectedCode, imageSize],
  );

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside style={{ width: 320, overflow: 'auto', borderRight: '1px solid #ccc', padding: 12 }}>
        <h2>Hiệu chỉnh kệ (Calibrate)</h2>
        <p>Chọn một vị trí, sau đó click lên bản đồ để đặt tọa độ.</p>
        <ul>
          {slots.map((s) => (
            <li
              key={s.code}
              onClick={() => setSelectedCode(s.code)}
              style={{
                cursor: 'pointer',
                padding: 4,
                background: s.code === selectedCode ? '#ffeb3b' : 'transparent',
              }}
            >
              {s.code} — {s.slotX != null && s.slotY != null ? `(${s.slotX.toFixed(2)}, ${s.slotY.toFixed(2)})` : 'chưa đặt'}
              {s.aprilTagId != null ? ` · tag ${s.aprilTagId}` : ''}
            </li>
          ))}
        </ul>
      </aside>
      <main style={{ flex: 1, position: 'relative', overflow: 'auto' }}>
        <img
          ref={imgRef}
          src={MAPS_URL}
          alt="SLAM map"
          onLoad={onImageLoad}
          onClick={onMapClick}
          style={{ maxWidth: '100%', cursor: selectedCode ? 'crosshair' : 'default' }}
        />
        {slots
          .filter((s) => s.slotX != null && s.slotY != null && imageSize.w > 0)
          .map((s) => {
            const METER_SCALE = 40 / imageSize.w;
            const px = (s.slotX! + 20) / METER_SCALE;
            const py = (20 - s.slotY!) / METER_SCALE;
            return (
              <div
                key={s.code}
                style={{
                  position: 'absolute',
                  left: px - 8,
                  top: py - 8,
                  width: 16,
                  height: 16,
                  background: s.code === selectedCode ? '#ffeb3b' : '#4caf50',
                  border: '2px solid white',
                  borderRadius: '50%',
                  pointerEvents: 'none',
                }}
                title={s.code}
              />
            );
          })}
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Build the web app**

```bash
cd apps/web
yarn build
```
Expected: builds without TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/calibrate/
git commit -m "feat(web): add /calibrate page for one-time warehouse setup"
```

---

### Task 1.9: End-to-end test of Phase 1

- [ ] **Step 1: Start the API and web**

```bash
# Terminal 1
cd apps/api && yarn start:dev

# Terminal 2
cd apps/web && yarn dev
```

- [ ] **Step 2: Verify the new endpoints**

```bash
# Set coordinates for S1A1
curl -X PUT http://localhost:5000/shelves/S1A1/coordinates \
  -H "Content-Type: application/json" \
  -d '{"slotX":1.5,"slotY":2.3,"facingTheta":0.0}'

# Verify
curl http://localhost:5000/shelves/slots | python -c "import json,sys; d=json.load(sys.stdin); print([s for s in d if s['code']=='S1A1'][0])"
```
Expected: response includes `"slotX": 1.5, "slotY": 2.3, "facingTheta": 0`.

- [ ] **Step 3: Verify the Calibrate page**

Open `http://localhost:3000/calibrate`. You should see the sidebar with 64 slots. Click a slot, then click on the map (if image loaded) — a marker should appear.

- [ ] **Step 4: Commit any final fixes**

No new commits unless something was found.

---

## Phase 2: Esp32Bridge + Tests

Goal: Build the `Esp32Bridge` Python module with `RealEsp32Bridge` and `FakeEsp32Bridge`. Full unit test coverage. This is the heart of the brain <-> ESP32 contract. After this phase, the brain can be developed and unit-tested end-to-end without the real ESP32.

### Task 2.1: Install test dependencies

**Files:**
- Create: `services/robot/src/my_robot_controller/requirements-test.txt`

- [ ] **Step 1: Create requirements-test.txt**

Create `d:\taiLieuHoc\robot-for-nguyen\services\robot\src\my_robot_controller\requirements-test.txt`:

```
pytest>=7.0
pytest-asyncio>=0.21
```

- [ ] **Step 2: Verify pytest is available on the Pi (post-deploy)**

After this task is shipped to the Pi:
```bash
pip3 install -r ~/robot_ws/src/my_robot_controller/requirements-test.txt
```
Expected: `Successfully installed pytest-... pytest-asyncio-...`

---

### Task 2.2: Write the failing test for FakeEsp32Bridge

**Files:**
- Create: `services/robot/src/my_robot_controller/tests/__init__.py` (empty)
- Create: `services/robot/src/my_robot_controller/tests/test_esp32_bridge.py`

- [ ] **Step 1: Create the tests directory**

```bash
mkdir -p services/robot/src/my_robot_controller/tests
```

- [ ] **Step 2: Create empty `__init__.py`**

Create `services/robot/src/my_robot_controller/tests/__init__.py` with empty content.

- [ ] **Step 3: Write the tests**

Create `services/robot/src/my_robot_controller/tests/test_esp32_bridge.py`:

```python
"""Unit tests for the Esp32Bridge interface.

The tests use FakeEsp32Bridge which records every command sent and
lets us inject responses for assertions.
"""
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from my_robot_controller.esp32_bridge import FakeEsp32Bridge, RealEsp32Bridge


@pytest.mark.asyncio
async def test_fake_bridge_records_move_command() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()
    await bridge.move(vx=100, vy=0, omega=0)
    await bridge.disconnect()

    sent = bridge.sent_commands()
    assert sent == [{'cmd': 'move', 'vx': 100, 'vy': 0, 'omega': 0}]


@pytest.mark.asyncio
async def test_fake_bridge_stop_command() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()
    await bridge.stop()
    await bridge.disconnect()

    assert bridge.sent_commands() == [{'cmd': 'stop'}]


@pytest.mark.asyncio
async def test_fake_bridge_e_stop_command() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()
    await bridge.e_stop()
    await bridge.disconnect()

    assert bridge.sent_commands() == [{'cmd': 'e_stop'}]


@pytest.mark.asyncio
async def test_fake_bridge_heartbeat_runs_at_interval() -> None:
    bridge = FakeEsp32Bridge(heartbeat_interval_s=0.01)
    await bridge.connect()
    await asyncio.sleep(0.05)
    await bridge.disconnect()

    sent = bridge.sent_commands()
    heartbeat_count = sum(1 for cmd in sent if cmd == {'cmd': 'heartbeat'})
    assert heartbeat_count >= 3, f'expected at least 3 heartbeats, got {heartbeat_count}'


@pytest.mark.asyncio
async def test_fake_bridge_injects_status_event() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()

    received: list[dict] = []
    bridge.on_status_update = lambda data: received.append(data)

    bridge.inject_status({'uptime_ms': 1234, 'mode': 'NAV', 'e_stop': False})
    await asyncio.sleep(0.01)

    assert received == [{'uptime_ms': 1234, 'mode': 'NAV', 'e_stop': False}]
    await bridge.disconnect()


@pytest.mark.asyncio
async def test_fake_bridge_serializes_concurrent_writes() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()

    await asyncio.gather(*[bridge.move(i, 0, 0) for i in range(10)])
    await bridge.disconnect()

    sent = bridge.sent_commands()
    assert len(sent) == 10
    assert [s['vx'] for s in sent] == list(range(10))


@pytest.mark.asyncio
async def test_real_bridge_encodes_move_as_json_line() -> None:
    writer = MagicMock()
    writer.write = MagicMock()
    writer.drain = AsyncMock()
    reader = MagicMock()
    reader.readline = AsyncMock(return_value=b'{"type":128,"data":{"cmd":"move"}}\n')

    bridge = RealEsp32Bridge(writer=writer, reader=reader)
    await bridge.move(vx=100, vy=0, omega=0)

    writer.write.assert_called_once()
    written_bytes = writer.write.call_args[0][0]
    assert written_bytes.endswith(b'\n')
    payload = json.loads(written_bytes.decode('utf-8').strip())
    assert payload == {'cmd': 'move', 'vx': 100, 'vy': 0, 'omega': 0}
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
cd services/robot
python3 -m pytest src/my_robot_controller/tests/test_esp32_bridge.py -v
```
Expected: `ModuleNotFoundError: No module named 'my_robot_controller.esp32_bridge'`

- [ ] **Step 5: Commit the failing test**

```bash
git add services/robot/src/my_robot_controller/tests/
git commit -m "test(robot): add FakeEsp32Bridge and RealEsp32Bridge failing tests"
```

---

### Task 2.3: Implement the Esp32Bridge interface, FakeEsp32Bridge, and RealEsp32Bridge

**Files:**
- Create: `services/robot/src/my_robot_controller/my_robot_controller/esp32_bridge.py`

- [ ] **Step 1: Create the file**

Create `d:\taiLieuHoc\robot-for-nguyen\services\robot\src\my_robot_controller\my_robot_controller\esp32_bridge.py`:

```python
"""Pi <-> ESP32 UART bridge.

This module defines:
  - Esp32Bridge: a Protocol describing the interface the brain uses
  - FakeEsp32Bridge: an in-memory implementation for unit tests
  - RealEsp32Bridge: a pyserial-asyncio implementation for production

The brain only ever talks to the Esp32Bridge Protocol; it never sees
the concrete implementation.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Optional, Protocol


class Esp32Bridge(Protocol):
    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def move(self, vx: int, vy: int, omega: int) -> None: ...
    async def stop(self) -> None: ...
    async def e_stop(self) -> None: ...
    async def clear_e_stop(self) -> None: ...
    async def heartbeat(self) -> None: ...
    async def get_status(self) -> dict: ...
    async def get_encoder(self) -> list[dict]: ...

    on_status_update: Callable[[dict], None]
    on_encoder_update: Callable[[list[dict]], None]
    on_e_stop: Callable[[], None]
    on_error: Callable[[str], None]


def _to_json_line(cmd: dict) -> bytes:
    """Encode a command as a newline-terminated JSON line (matches the ESP32 protocol)."""
    return (json.dumps(cmd) + '\n').encode('utf-8')


class FakeEsp32Bridge:
    """In-memory Esp32Bridge for unit tests.

    Records every command sent to .sent_commands(). Use .inject_*() to
    simulate the ESP32 emitting events back to the brain.
    """

    def __init__(self, heartbeat_interval_s: float = 0.05) -> None:
        self._commands: list[dict] = []
        self._lock = asyncio.Lock()
        self._heartbeat_task: Optional[asyncio.Task[None]] = None
        self._heartbeat_interval = heartbeat_interval_s
        self._connected = False

        self.on_status_update: Callable[[dict], None] = lambda _data: None
        self.on_encoder_update: Callable[[list[dict]], None] = lambda _data: None
        self.on_e_stop: Callable[[], None] = lambda: None
        self.on_error: Callable[[str], None] = lambda _msg: None

    async def connect(self) -> None:
        self._connected = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def disconnect(self) -> None:
        self._connected = False
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

    async def move(self, vx: int, vy: int, omega: int) -> None:
        await self._send({'cmd': 'move', 'vx': vx, 'vy': vy, 'omega': omega})

    async def stop(self) -> None:
        await self._send({'cmd': 'stop'})

    async def e_stop(self) -> None:
        await self._send({'cmd': 'e_stop'})

    async def clear_e_stop(self) -> None:
        await self._send({'cmd': 'e_stop_clear'})

    async def heartbeat(self) -> None:
        await self._send({'cmd': 'heartbeat'})

    async def get_status(self) -> dict:
        return {'uptime_ms': 0, 'mode': 'NAV', 'e_stop': False}

    async def get_encoder(self) -> list[dict]:
        return []

    def sent_commands(self) -> list[dict]:
        return list(self._commands)

    def inject_status(self, data: dict) -> None:
        self.on_status_update(data)

    def inject_encoder(self, data: list[dict]) -> None:
        self.on_encoder_update(data)

    def inject_e_stop(self) -> None:
        self.on_e_stop()

    def inject_error(self, message: str) -> None:
        self.on_error(message)

    async def _send(self, cmd: dict) -> None:
        async with self._lock:
            if not self._connected:
                raise RuntimeError('FakeEsp32Bridge: not connected')
            self._commands.append(cmd)

    async def _heartbeat_loop(self) -> None:
        while self._connected:
            await asyncio.sleep(self._heartbeat_interval)
            try:
                await self.heartbeat()
            except Exception:  # noqa: BLE001
                pass


class RealEsp32Bridge:
    """UART-backed Esp32Bridge.

    Takes a pre-opened StreamReader/StreamWriter pair (from
    pyserial-asyncio's SerialTransport.open_serial_connection). This
    indirection lets tests inject mock streams.
    """

    def __init__(self, writer: Any, reader: Any) -> None:
        self._writer = writer
        self._reader = reader
        self._lock = asyncio.Lock()
        self._connected = False
        self._heartbeat_task: Optional[asyncio.Task[None]] = None
        self._heartbeat_interval = 0.05

        self.on_status_update: Callable[[dict], None] = lambda _data: None
        self.on_encoder_update: Callable[[list[dict]], None] = lambda _data: None
        self.on_e_stop: Callable[[], None] = lambda: None
        self.on_error: Callable[[str], None] = lambda _msg: None

    async def connect(self) -> None:
        self._connected = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def disconnect(self) -> None:
        self._connected = False
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

    async def move(self, vx: int, vy: int, omega: int) -> None:
        await self._send_line({'cmd': 'move', 'vx': vx, 'vy': vy, 'omega': omega})

    async def stop(self) -> None:
        await self._send_line({'cmd': 'stop'})

    async def e_stop(self) -> None:
        await self._send_line({'cmd': 'e_stop'})

    async def clear_e_stop(self) -> None:
        await self._send_line({'cmd': 'e_stop_clear'})

    async def heartbeat(self) -> None:
        await self._send_line({'cmd': 'heartbeat'})

    async def get_status(self) -> dict:
        return {'uptime_ms': 0, 'mode': 'NAV', 'e_stop': False}

    async def get_encoder(self) -> list[dict]:
        return []

    async def _send_line(self, cmd: dict) -> None:
        async with self._lock:
            if not self._connected:
                raise RuntimeError('RealEsp32Bridge: not connected')
            line = _to_json_line(cmd)
            self._writer.write(line)
            await self._writer.drain()

    async def _heartbeat_loop(self) -> None:
        while self._connected:
            await asyncio.sleep(self._heartbeat_interval)
            try:
                await self.heartbeat()
            except Exception:  # noqa: BLE001
                self.on_error('heartbeat failed')
```

- [ ] **Step 2: Run all tests**

```bash
cd services/robot
python3 -m pytest src/my_robot_controller/tests/test_esp32_bridge.py -v
```
Expected: 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add services/robot/src/my_robot_controller/my_robot_controller/esp32_bridge.py
git commit -m "feat(robot): add Esp32Bridge Protocol, FakeEsp32Bridge, RealEsp32Bridge"
```

---

### Task 2.4: Add conftest.py for pytest-asyncio

**Files:**
- Create: `services/robot/src/my_robot_controller/tests/conftest.py`

- [ ] **Step 1: Create the file**

Create `d:\taiLieuHoc\robot-for-nguyen\services\robot\src\my_robot_controller\tests\conftest.py`:

```python
"""Pytest configuration for my_robot_controller tests."""
import pytest


@pytest.fixture(scope='session')
def event_loop():
    import asyncio
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
```

- [ ] **Step 2: Verify the tests still pass**

```bash
cd services/robot
python3 -m pytest src/my_robot_controller/tests/ -v
```
Expected: 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add services/robot/src/my_robot_controller/tests/conftest.py
git commit -m "test(robot): add pytest-asyncio conftest"
```

---

### Task 2.5: Wire brain_node.py to use FakeEsp32Bridge (no movement yet)

**Files:**
- Modify: `services/robot/src/my_robot_controller/my_robot_controller/brain_node.py`

- [ ] **Step 1: Replace brain_node.py with state-machine skeleton**

Replace the contents of `d:\taiLieuHoc\robot-for-nguyen\services\robot\src\my_robot_controller\my_robot_controller\brain_node.py` with:

```python
"""Brain controller — high-level state machine for the warehouse robot.

Phase 2 skeleton: declares the 7 states, instantiates FakeEsp32Bridge,
logs state transitions. Phase 5+ will wire up Nav2, vision, and the
API Socket.io client.
"""
from __future__ import annotations

from enum import Enum

import rclpy
from rclpy.node import Node

from my_robot_controller.esp32_bridge import Esp32Bridge, FakeEsp32Bridge


class BrainState(str, Enum):
    BOOT = 'BOOT'
    EXPLORE = 'EXPLORE'
    MAPPING_DONE = 'MAPPING_DONE'
    IDLE = 'IDLE'
    JOB_NAV_TO_PICKUP = 'JOB_NAV_TO_PICKUP'
    JOB_WAIT_FOR_CLEAR = 'JOB_WAIT_FOR_CLEAR'
    JOB_NAV_TO_DROPOFF = 'JOB_NAV_TO_DROPOFF'
    JOB_PLACE = 'JOB_PLACE'
    E_STOP = 'E_STOP'
    ERROR = 'ERROR'


class BrainNode(Node):
    def __init__(self) -> None:
        super().__init__('brain')
        self._state: BrainState = BrainState.BOOT
        self._bridge: Esp32Bridge = FakeEsp32Bridge()
        self.get_logger().info(f'brain_node started in state {self._state}')

    def transition_to(self, new_state: BrainState, reason: str = '') -> None:
        old = self._state
        self._state = new_state
        self.get_logger().info(f'state: {old} -> {new_state} ({reason})')

    @property
    def state(self) -> BrainState:
        return self._state


def main() -> None:
    rclpy.init()
    node = BrainNode()
    rclpy.spin(node)
    rclpy.shutdown()


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Build the ROS 2 package**

```bash
cd ~/robot_ws
colcon build --merge-install --executor sequential --packages-select my_robot_controller
```
Expected: builds without errors.

- [ ] **Step 3: Smoke test the brain node**

```bash
source install/setup.bash
timeout 5 ros2 run my_robot_controller brain 2>&1 | head -20
```
Expected: log line `brain_node started in state BrainState.BOOT` and no crashes.

- [ ] **Step 4: Commit**

```bash
git add services/robot/src/my_robot_controller/my_robot_controller/brain_node.py
git commit -m "feat(robot): brain_node state machine skeleton with FakeEsp32Bridge"
```

---

### Task 2.6: Add a state-transition test for the brain

**Files:**
- Create: `services/robot/src/my_robot_controller/tests/test_brain_node.py`

- [ ] **Step 1: Write the test**

Create `d:\taiLieuHoc\robot-for-nguyen\services\robot\src\my_robot_controller\tests\test_brain_node.py`:

```python
"""Unit tests for the BrainNode state machine.

These tests don't spin up rclpy; they construct the BrainNode class
directly and exercise its transition_to() method. This lets us verify
the state machine logic without ROS infrastructure.
"""
import pytest

from my_robot_controller.brain_node import BrainNode, BrainState


@pytest.fixture
def brain() -> BrainNode:
    """Construct a BrainNode without rclpy spin.

    We monkey-patch rclpy's Node.__init__ to skip the heavy ROS setup.
    """
    # Patch out rclpy.node.Node.__init__ before constructing BrainNode.
    import rclpy.node
    original_init = rclpy.node.Node.__init__

    def _noop_init(self, name: str) -> None:
        # Skip rclpy.node.Node setup; just stash the name.
        self.__dict__['_name'] = name

    rclpy.node.Node.__init__ = _noop_init  # type: ignore[assignment]
    try:
        node = BrainNode()
        yield node
    finally:
        rclpy.node.Node.__init__ = original_init  # type: ignore[assignment]


def test_brain_starts_in_boot(brain: BrainNode) -> None:
    assert brain.state == BrainState.BOOT


def test_brain_can_transition_to_idle(brain: BrainNode) -> None:
    brain.transition_to(BrainState.IDLE, reason='boot complete')
    assert brain.state == BrainState.IDLE


def test_brain_can_transition_to_job_states(brain: BrainNode) -> None:
    brain.transition_to(BrainState.JOB_NAV_TO_PICKUP, reason='job dispatch')
    assert brain.state == BrainState.JOB_NAV_TO_PICKUP
    brain.transition_to(BrainState.JOB_NAV_TO_DROPOFF, reason='pickup complete')
    assert brain.state == BrainState.JOB_NAV_TO_DROPOFF
    brain.transition_to(BrainState.JOB_PLACE, reason='dropoff complete')
    assert brain.state == BrainState.JOB_PLACE
    brain.transition_to(BrainState.IDLE, reason='job complete')
    assert brain.state == BrainState.IDLE


def test_brain_can_transition_to_e_stop(brain: BrainNode) -> None:
    brain.transition_to(BrainState.E_STOP, reason='IR sensor trip')
    assert brain.state == BrainState.E_STOP


def test_brain_can_transition_to_wait_for_clear(brain: BrainNode) -> None:
    brain.transition_to(BrainState.JOB_NAV_TO_DROPOFF)
    brain.transition_to(BrainState.JOB_WAIT_FOR_CLEAR, reason='destination occupied')
    assert brain.state == BrainState.JOB_WAIT_FOR_CLEAR


def test_brain_uses_fake_esp32_bridge(brain: BrainNode) -> None:
    """The brain's _bridge should be a FakeEsp32Bridge in Phase 2."""
    from my_robot_controller.esp32_bridge import FakeEsp32Bridge
    assert isinstance(brain._bridge, FakeEsp32Bridge)
```

- [ ] **Step 2: Run the test**

```bash
cd services/robot
python3 -m pytest src/my_robot_controller/tests/test_brain_node.py -v
```
Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add services/robot/src/my_robot_controller/tests/test_brain_node.py
git commit -m "test(robot): add BrainNode state machine tests"
```

---

### Task 2.7: End-to-end test of Phase 2

- [ ] **Step 1: Run the full test suite**

```bash
cd services/robot
python3 -m pytest src/my_robot_controller/tests/ -v
```
Expected: 13 tests pass (7 from esp32_bridge + 6 from brain_node).

- [ ] **Step 2: Build the ROS package**

```bash
cd ~/robot_ws
colcon build --merge-install --executor sequential --packages-select my_robot_controller
```
Expected: builds without errors.

- [ ] **Step 3: Verify brain can be PM2-launched (post-deploy)**

After deploy.sh is updated (Task 0.6), on the Pi:
```bash
pm2 restart nexus-robot-brain
pm2 logs nexus-robot-brain --lines 20
```
Expected: `brain_node started in state BrainState.BOOT` and no crash loops.

- [ ] **Step 4: Commit any final fixes**

No new commits unless issues were found.

---

## After Phase 2

Phases 0, 1, and 2 are **shippable together as a single PR** since each phase is independently verifiable. The PR should be reviewed against:

- All TypeScript builds pass: `yarn turbo run build --filter=...`
- All Python tests pass: `pytest src/my_robot_controller/tests/`
- Lint passes: `yarn turbo run lint --filter=...`
- The brain node can be PM2-launched on the Pi
- The Calibrate page renders and the new endpoints work
- The fake-ESP32 brain node logs state transitions correctly

## Phases 3-7 (separate plans)

These will be written as separate plan files when each phase is ready to start. The spec at `docs/superpowers/specs/2026-06-07-robot-controller-brain-design.md` is the source of truth.

| Phase | Title | High-level tasks |
|---|---|---|
| 3 | Nav2 bringup | Install nav2-bringup on Pi, fill in `nav2_launch.py` with AMCL + planner + DWA, fill in `nav2_params.yaml`, smoke test AMCL localization |
| 4 | API Gateway | Create `robot.gateway.ts` + `robot.service.ts` with `/robot` namespace, create `job.schema.ts` + `job-service.ts` with `dispatchMove()`, rewire `PUT /shelves/:slotCode/package` to return 202, emit `job:dispatch` to brain |
| 5 | Brain wiring | Brain subscribes to API Socket.io events, drives the state machine through `JOB_NAV_TO_PICKUP` -> ... -> `IDLE` (faked movement: sleep + emit status), live updates the web `/map` page |
| 6 | Real movement | Replace `FakeEsp32Bridge` with `RealEsp32Bridge` backed by `pyserial-asyncio`, connect to real ESP32 UART, drive real motors via Nav2, no arm yet (operator loads/unloads) |
| 7 | Arm + pickup/place | (Later) ESP32 firmware gets arm + IMU + odometry, brain does the full pickup/place sequence |

Each phase ends with a verifiable smoke test, commit, and a green `pm2 list` on the Pi.
