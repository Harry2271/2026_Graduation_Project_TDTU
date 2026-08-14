import { forwardRef, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
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
import { EventsGateway } from '../../gateway/events-gateway';
import { RobotService } from './robot.service';

@WebSocketGateway({
  namespace: '/robot',
  cors: {
    // Restrict to known origins. The robot namespace is internal — only
    // the Pi brain on the same network should connect. Web clients use
    // the default namespace (`/`) on the same port.
    origin: [
      'https://web.nguyen-robot.io.vn',
      'http://localhost:3000',
      'http://localhost:8081',
    ],
    credentials: true,
  },
})
export class RobotGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RobotGateway.name);

  @WebSocketServer()
  server!: Server;

  /** Pending cancel acks — keyed by jobId, resolved when brain acknowledges. */
  private readonly _pendingCancelAcks = new Map<string, (acked: boolean) => void>();

  constructor(
    private configService: ConfigService,
    private robotService: RobotService,
    @Inject(forwardRef(() => JobService))
    private jobService: JobService,
    private shelfService: ShelfService,
    private eventsGateway: EventsGateway,
  ) {}

  private constantTimeTokenEquals(provided: unknown, expected: string): boolean {
    if (typeof provided !== 'string' || provided.length === 0) {
      // Still run timingSafeEqual on padded buffers to avoid length-based
      // early-return shortcuts in the comparison path.
      const dummy = Buffer.alloc(expected.length);
      crypto.timingSafeEqual(dummy, dummy);
      return false;
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  handleConnection(client: Socket): void {
    const token: unknown = client.handshake.auth?.token;
    const expected = this.configService.get<string>('ROBOT_BRAIN_TOKEN');
    if (!expected) {
      this.logger.error('ROBOT_BRAIN_TOKEN not configured — rejecting all connections');
      client.disconnect(true);
      return;
    }
    if (!this.constantTimeTokenEquals(token, expected)) {
      this.logger.warn(`Rejected connection from ${client.id} — invalid token`);
      client.disconnect(true);
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

  // ── Cancel-ack from brain ─────────────────────────────────────────

  @SubscribeMessage('job:cancel:ack')
  handleJobCancelAck(
    _client: Socket,
    payload: { jobId: string },
  ): void {
    this.logger.log(`job:cancel:ack from brain — ${payload.jobId}`);
    const resolve = this._pendingCancelAcks.get(payload.jobId);
    if (resolve) {
      this._pendingCancelAcks.delete(payload.jobId);
      resolve(true);
    }
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
      completedAt?: string;
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
      completedAt: payload.completedAt ? new Date(payload.completedAt) : undefined,
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

  @SubscribeMessage('robot:error')
  handleRobotError(
    _client: Socket,
    payload: { severity?: string; code?: string; message?: string },
  ): void {
    this.logger.error(
      `Robot error: [${payload.severity ?? 'error'}] ` +
      `${payload.code ?? 'UNKNOWN'} — ${payload.message ?? 'unknown'}`,
    );
    this.eventsGateway.emitRobotError({
      ts: new Date().toISOString(),
      severity: payload.severity ?? 'error',
      code: payload.code ?? 'UNKNOWN',
      message: payload.message ?? 'Robot reported an error',
    });
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

  /**
   * Notify the brain that a job has been cancelled and wait for an ack.
   *
   * Returns ``true`` if the brain acknowledged within `timeoutMs`,
   * ``false`` on timeout or if the brain is not connected. The caller
   * uses this to decide whether to release the destination slot.
   */
  async dispatchCancel(jobId: string, timeoutMs = 500): Promise<boolean> {
    const brain = this.robotService.getBrain();
    if (!brain || !brain.connected) {
      this.logger.warn(`Cannot dispatch cancel for ${jobId} — brain not connected`);
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this._pendingCancelAcks.delete(jobId)) {
          this.logger.warn(`Cancel ack timeout for ${jobId} after ${timeoutMs}ms`);
          resolve(false);
        }
      }, timeoutMs);

      this._pendingCancelAcks.set(jobId, (acked: boolean) => {
        clearTimeout(timer);
        resolve(acked);
      });

      try {
        brain.emit('job:cancel', { jobId });
        this.logger.log(`Cancel notification sent to brain for ${jobId}`);
      } catch (err) {
        this.logger.error(`Failed to emit job:cancel for ${jobId}: ${err}`);
        if (this._pendingCancelAcks.delete(jobId)) {
          clearTimeout(timer);
          resolve(false);
        }
      }
    });
  }
}
