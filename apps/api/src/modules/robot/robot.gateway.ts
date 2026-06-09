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

import { Job, JobStatus } from '../job/job.schema';
import { JobService } from '../job/job.service';
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
  }

  handleDisconnect(client: Socket): void {
    this.robotService.unregisterBrain(client.id);
    this.logger.log(`Brain disconnected: ${client.id}`);
  }

  @SubscribeMessage('job:status')
  async handleJobStatus(
    _client: Socket,
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
