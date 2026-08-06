import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';

export interface RobotHealth {
  connected: boolean;
  runningJobId: string | null;
  lastSeenAt: string | null;
}

@Injectable()
export class RobotService {
  private readonly logger = new Logger(RobotService.name);
  private brainClient: Socket | null = null;
  private brainId: string | null = null;

  /** Job currently being executed by the brain. Null when idle. */
  private runningJobId: string | null = null;

  /** Last health heartbeat received from brain (ISO timestamp). */
  private lastHealthAt: string | null = null;

  registerBrain(client: Socket): boolean {
    if (this.brainClient?.connected) {
      this.logger.warn(
        `Brain ${client.id} connecting but ${this.brainId ?? 'unknown'} already active — disconnecting old`,
      );
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
      // Brain dropped — clear running job so on reconnect we can re-dispatch.
      this.runningJobId = null;
    }
  }

  getBrain(): Socket | null {
    return this.brainClient;
  }

  isBrainConnected(): boolean {
    return this.brainClient?.connected === true;
  }

  // ── Queue/Job tracking ───────────────────────────────────────────────

  isJobRunning(): boolean {
    return this.runningJobId !== null;
  }

  markJobRunning(jobId: string): void {
    this.runningJobId = jobId;
  }

  markJobIdle(): void {
    this.runningJobId = null;
  }

  // ── Health snapshot (Phase 5 dashboard) ─────────────────────────────

  recordHealth(): void {
    this.lastHealthAt = new Date().toISOString();
  }

  getHealth(): RobotHealth {
    return {
      connected: this.isBrainConnected(),
      runningJobId: this.runningJobId,
      lastSeenAt: this.lastHealthAt,
    };
  }
}
