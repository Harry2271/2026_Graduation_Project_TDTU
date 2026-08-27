/**
 * Robot WebSocket connection (port 9091).
 * 
 * This is a direct WebSocket connection to the robot's web_bridge.py server
 * for real-time SLAM, LiDAR, and AprilTag detection events.
 * 
 * Separate from lib/socket.ts which connects to the NestJS API Socket.io server.
 */

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'wss://map.nguyen-robot.io.vn'
const WS_AUTH_TOKEN = process.env.NEXT_PUBLIC_WS_AUTH_TOKEN

function authenticatedWsUrl(url: string): string {
  if (!WS_AUTH_TOKEN) return url
  const wsUrl = new URL(url)
  wsUrl.searchParams.set('token', WS_AUTH_TOKEN)
  return wsUrl.toString()
}

interface RobotMessage {
  type: string
  data?: unknown
}

type RobotEventListener = (data: unknown) => void

let ws: WebSocket | null = null
const listeners = new Map<string, Set<RobotEventListener>>()
let reconnectTimeout: NodeJS.Timeout | null = null
let isIntentionallyClosed = false

export function getRobotSocket(): {
  on: (event: string, listener: RobotEventListener) => void
  off: (event: string, listener: RobotEventListener) => void
  send: (data: unknown) => void
  isConnected: () => boolean
} {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    connect()
  }

  return {
    on: (event: string, listener: RobotEventListener) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set())
      }
      listeners.get(event)!.add(listener)
    },
    off: (event: string, listener: RobotEventListener) => {
      listeners.get(event)?.delete(listener)
    },
    send: (data: unknown) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data))
      }
    },
    isConnected: () => ws?.readyState === WebSocket.OPEN,
  }
}

function connect() {
  if (ws && ws.readyState !== WebSocket.CLOSED) return

  try {
    isIntentionallyClosed = false
    ws = new WebSocket(authenticatedWsUrl(WS_URL))

    ws.onopen = () => {
      console.log('[RobotWS] Connected:', WS_URL)
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
        reconnectTimeout = null
      }
    }

    ws.onmessage = (event) => {
      try {
        let msg: RobotMessage
        if (typeof event.data === 'string') {
          msg = JSON.parse(event.data) as RobotMessage
        } else {
          // Gzipped binary (map_layer, obstacle_layer)
          return
        }

        const eventListeners = listeners.get(msg.type)
        if (eventListeners) {
          eventListeners.forEach((listener) => listener(msg.data))
        }
      } catch (err) {
        console.warn('[RobotWS] Failed to parse message:', err)
      }
    }

    ws.onerror = (err) => {
      console.warn('[RobotWS] Connection error:', err)
    }

    ws.onclose = () => {
      console.log('[RobotWS] Disconnected')
      ws = null

      // Auto-reconnect unless intentionally closed
      if (!isIntentionallyClosed) {
        reconnectTimeout = setTimeout(() => {
          console.log('[RobotWS] Reconnecting...')
          connect()
        }, 3000)
      }
    }
  } catch (err) {
    console.error('[RobotWS] Failed to connect:', err)
    // Retry after delay
    reconnectTimeout = setTimeout(connect, 3000)
  }
}

export function disconnectRobotSocket(): void {
  isIntentionallyClosed = true
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  listeners.clear()
}
