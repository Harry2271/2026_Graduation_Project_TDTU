import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';

@Injectable()
export class RobotService {
  private readonly logger = new Logger(RobotService.name);
  private brainClient: Socket | null = null;
  private brainId: string | null = null;

  registerBrain(client: Socket): boolean {
    if (this.brainClient && this.brainClient.connected) {
      this.logger.warn(
        `Brain ${client.id} connecting but ${this.brainId} already active — disconnecting old`,
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
    }
  }

  getBrain(): Socket | null {
    return this.brainClient;
  }

  isBrainConnected(): boolean {
    return this.brainClient !== null && this.brainClient.connected;
  }
}
