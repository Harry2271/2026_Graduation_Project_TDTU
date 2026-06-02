import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: ['https://web.nguyen-robot.io.vn', 'http://localhost:3000', 'http://localhost:8081'],
    credentials: true,
  },
})
export class EventsGateway {
  @WebSocketServer()
  server: Server;

  emitPackageCreated(data: unknown) {
    this.server.emit('package:created', data);
  }

  emitPackageUpdated(data: unknown) {
    this.server.emit('package:updated', data);
  }

  emitPackageDeleted(id: string) {
    this.server.emit('package:deleted', id);
  }

  emitShelfUpdated(data: unknown) {
    this.server.emit('shelf:updated', data);
  }
}
