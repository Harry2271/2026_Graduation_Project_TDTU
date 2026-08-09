import { io, Socket } from 'socket.io-client';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

let socket: Socket | null = null;
let cachedToken: string | null = null;

function buildOptions() {
  return {
    transports: ['websocket'] as Array<'websocket'>,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    auth: cachedToken ? { token: cachedToken } : undefined,
  };
}

export function setAuthToken(token: string | null) {
  cachedToken = token;
  // If a socket is already connected, update its auth and reconnect
  // so the server sees the new token on the next handshake.
  if (socket) {
    socket.auth = token ? { token } : undefined;
    socket.disconnect();
    socket.connect();
  }
}

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_BASE, buildOptions());
  }
  return socket;
}

export function reconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  socket = io(API_BASE, buildOptions());
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}