"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface MissionStats {
  total_distance_m: number;
  total_runtime_s: number;
  deliveries_completed: number;
  average_speed_mps: number;
  total_energy_wh: number;
  ts: number;
}

export function MissionStatsCard() {
  const [stats, setStats] = useState<MissionStats | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Connect to the WebSocket server for mission stats
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:9091";
    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;

    const connect = () => {
      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setConnected(true);
          console.log("[MissionStats] WebSocket connected");
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);

            // Listen for mission_stats topic
            if (message.topic === "/mission_stats" && message.data) {
              const parsed = typeof message.data === "string"
                ? JSON.parse(message.data)
                : message.data;
              setStats(parsed);
            }
          } catch (err) {
            console.error("[MissionStats] Parse error:", err);
          }
        };

        ws.onerror = (error) => {
          console.error("[MissionStats] WebSocket error:", error);
          setConnected(false);
        };

        ws.onclose = () => {
          setConnected(false);
          console.log("[MissionStats] WebSocket closed, reconnecting in 5s");
          reconnectTimer = setTimeout(connect, 5000);
        };
      } catch (err) {
        console.error("[MissionStats] Connection error:", err);
        reconnectTimer = setTimeout(connect, 5000);
      }
    };

    connect();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.close();
      }
    };
  }, []);

  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  const formatDistance = (meters: number): string => {
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    return `${meters.toFixed(1)} m`;
  };

  const formatSpeed = (mps: number): string => {
    return `${(mps * 3.6).toFixed(2)} km/h`;
  };

  const formatEnergy = (wh: number): string => {
    if (wh >= 1000) {
      return `${(wh / 1000).toFixed(2)} kWh`;
    }
    return `${wh.toFixed(1)} Wh`;
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Thống kê nhiệm vụ</span>
          <span className={`text-sm ${connected ? "text-green-500" : "text-gray-400"}`}>
            {connected ? "●" : "○"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {stats ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {/* Total Distance */}
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Tổng quãng đường</p>
              <p className="text-2xl font-bold">{formatDistance(stats.total_distance_m)}</p>
            </div>

            {/* Total Runtime */}
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Thời gian vận hành</p>
              <p className="text-2xl font-bold">{formatDuration(stats.total_runtime_s)}</p>
            </div>

            {/* Deliveries Completed */}
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Giao hàng hoàn thành</p>
              <p className="text-2xl font-bold">{stats.deliveries_completed}</p>
            </div>

            {/* Average Speed */}
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Tốc độ trung bình</p>
              <p className="text-2xl font-bold">{formatSpeed(stats.average_speed_mps)}</p>
            </div>

            {/* Total Energy */}
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Năng lượng tiêu thụ</p>
              <p className="text-2xl font-bold">{formatEnergy(stats.total_energy_wh)}</p>
            </div>

            {/* Efficiency (optional derived metric) */}
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Hiệu suất</p>
              <p className="text-2xl font-bold">
                {stats.total_distance_m > 0 && stats.total_energy_wh > 0
                  ? `${((stats.total_distance_m / 1000) / (stats.total_energy_wh / 1000)).toFixed(2)} km/kWh`
                  : "—"}
              </p>
            </div>
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-8">
            {connected ? "Đang chờ dữ liệu..." : "Đang kết nối..."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
