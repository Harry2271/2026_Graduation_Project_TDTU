import { forwardRef, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { Job, JobPhase, JobStatus } from '../job/job.schema';
import { JobService } from '../job/job.service';
import { ShelfService } from '../shelf/shelf-service';
import { RobotService } from './robot.service';

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
    @Inject(forwardRef(() => JobService))
    private jobService: JobService,
    private shelfService: ShelfService,
  ) {}

  handleConnection(client: Socket): void {
    const token: unknown = client.handshake.auth?.token;
    const expected: string | undefined = this.configService.get<string>('ROBOT_BRAIN_TOKEN');
    if (!token || token !== expected) {
      this.logger.warn(`Rejected connection from ${client.id} — invalid token`);
      client.disconnect();
      return;
    }
    this.robotService.registerBrain(client);
    this.logger.log(`Brain connected: ${client.id}`);

    // Trigger queue drain on reconnection — brain may have dropped mid-job.
    this.jobService.tryDispatchNext().catch((e) => this.logger.warn('tryDispatchNext failed', e));
  }

  handleDisconnect(client: Socket): void {
    this.robotService.unregisterBrain(client.id);
    this.logger.log(`Brain disconnected: ${client.id}`);
  }

  // ── Brain → API messages ─────────────────────────────────────────────

  @SubscribeMessage('job:status')
  async handleJobStatus(
    _client: Socket,
    payload: { jobId: string; status: JobStatus; failureReason?: string },
  ): Promise<void> {
    this.logger.log(`job:status from brain — ${payload.jobId} → ${payload.status}`);
    await this.jobService.updateStatus(payload.jobId, payload.status);
  }

  @SubscribeMessage('job:phase')
  async handleJobPhase(
    _client: Socket,
    payload: { jobId: string; phase: JobPhase },
  ): Promise<void> {
    this.logger.log(`job:phase from brain — ${payload.jobId} → ${payload.phase}`);
    await this.jobService.updatePhase(payload.jobId, payload.phase);
  }

  @SubscribeMessage('job:timing')
  async handleJobTiming(
    _client: Socket,
    payload: {
      jobId: string;
      startedAt?: string;
      pickupAt?: string;
      dropoffAt?: string;
      unloadAt?: string;
      totalDurationMs?: number;
      fullCycleDurationMs?: number;
      travelToPickupMs?: number;
      travelToDropoffMs?: number;
      unloadDurationMs?: number;
    },
  ): Promise<void> {
    this.logger.log(`job:timing from brain — ${payload.jobId} total=${payload.totalDurationMs ?? '?'}ms`);
    await this.jobService.updateTiming(payload.jobId, {
      startedAt: payload.startedAt ? new Date(payload.startedAt) : undefined,
      pickupAt: payload.pickupAt ? new Date(payload.pickupAt) : undefined,
      dropoffAt: payload.dropoffAt ? new Date(payload.dropoffAt) : undefined,
      unloadAt: payload.unloadAt ? new Date(payload.unloadAt) : undefined,
      totalDurationMs: payload.totalDurationMs,
      fullCycleDurationMs: payload.fullCycleDurationMs,
      travelToPickupMs: payload.travelToPickupMs,
      travelToDropoffMs: payload.travelToDropoffMs,
      unloadDurationMs: payload.unloadDurationMs,
    });
  }

  @SubscribeMessage('robot:health')
  handleHealth(
    _client: Socket,
    _payload: Record<string, unknown>,
  ): void {
    this.robotService.recordHealth();
    // No reply needed — brain fires this every 5 s as a keepalive.
  }

  // ── API → Brain dispatch ─────────────────────────────────────────────

  async dispatchJob(job: Job): Promise<void> {
    if (!this.robotService.isBrainConnected()) {
      this.logger.warn('Cannot dispatch job — brain not connected');
      return;
    }

    // Resolve destination slot coordinates so brain can navigate to the map pose
    const toSlot = await this.shelfService.findSlotByCode(job.toSlotCode);

    const dropoff = toSlot && toSlot.slotX !== undefined
      ? { x: toSlot.slotX, y: toSlot.slotY ?? 0, theta: toSlot.facingTheta ?? 0, tag_id: toSlot.aprilTagId ?? null }
      : null;

    this.server.emit('job:dispatch', {
      _id: job._id,
      operationId: job.operationId,
      toSlotCode: job.toSlotCode,
      dropoff,
      dock_distance_mm: 40,
    });
    this.logger.log(`Dispatch ${job._id}: → ${job.toSlotCode} dropoff=${dropoff ? 'ok' : 'none'}`);
  }
}
