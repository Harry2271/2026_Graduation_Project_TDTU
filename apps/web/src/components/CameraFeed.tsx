"use client";

import { useEffect, useRef, useState } from "react";

interface Obstacle {
  x: number;
  y: number;
  width: number;
  height: number;
  distance: number;
}

interface Waypoint {
  x: number;
  y: number;
  label: string;
}

interface PathPoint {
  x: number;
  y: number;
}

interface CameraFeedProps {
  piIp?: string;
  streamPort?: number;
  showObstacles?: boolean;
  showPath?: boolean;
  showWaypoints?: boolean;
}

/**
 * AR Camera Feed with Canvas Overlay
 *
 * Architecture:
 * - MJPEG stream from Pi (mjpg-streamer assumed)
 * - Canvas overlay for drawing robot perception data
 * - Obstacle boxes from LiDAR /scan topic (stub data)
 * - Planned path polyline from Nav2 /plan topic (stub data)
 * - Target waypoint markers (stub data)
 *
 * Real implementation requires:
 * - ROS bridge.js client to subscribe to /scan and /plan topics
 * - Coordinate transformation from robot frame to camera pixel space
 * - Integration with apps/api Socket.io for real-time data relay
 */
export default function CameraFeed({
  piIp = process.env.NEXT_PUBLIC_PI_IP || "192.168.1.100",
  streamPort = 8080,
  showObstacles = true,
  showPath = true,
  showWaypoints = true,
}: CameraFeedProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLImageElement>(null);
  const [isStreamActive, setIsStreamActive] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 640, height: 480 });

  // Stub data - replace with ROS bridge.js subscriptions
  const [obstacles] = useState<Obstacle[]>([
    { x: 150, y: 200, width: 80, height: 120, distance: 1.2 },
    { x: 400, y: 150, width: 60, height: 100, distance: 2.5 },
  ]);

  const [plannedPath] = useState<PathPoint[]>([
    { x: 320, y: 400 },
    { x: 280, y: 320 },
    { x: 250, y: 240 },
    { x: 220, y: 160 },
    { x: 200, y: 80 },
  ]);

  const [targetWaypoint] = useState<Waypoint>({
    x: 200,
    y: 80,
    label: "Pickup A3",
  });

  const streamUrl = `http://${piIp}:${streamPort}/stream.mjpg`;

  // Handle video load to get actual dimensions
  useEffect(() => {
    const img = videoRef.current;
    if (!img) return;

    const handleLoad = () => {
      setIsStreamActive(true);
      setDimensions({
        width: img.naturalWidth || 640,
        height: img.naturalHeight || 480,
      });
    };

    const handleError = () => {
      setIsStreamActive(false);
      console.error("Camera stream failed to load:", streamUrl);
    };

    img.addEventListener("load", handleLoad);
    img.addEventListener("error", handleError);

    return () => {
      img.removeEventListener("load", handleLoad);
      img.removeEventListener("error", handleError);
    };
  }, [streamUrl]);

  // Canvas drawing loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw planned path
      if (showPath && plannedPath.length > 1) {
        ctx.strokeStyle = "#00d4ff";
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(plannedPath[0].x, plannedPath[0].y);
        for (let i = 1; i < plannedPath.length; i++) {
          ctx.lineTo(plannedPath[i].x, plannedPath[i].y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw obstacle bounding boxes
      if (showObstacles) {
        obstacles.forEach((obs) => {
          ctx.strokeStyle = "#ff3b5c";
          ctx.lineWidth = 2;
          ctx.strokeRect(obs.x, obs.y, obs.width, obs.height);

          // Distance label
          ctx.fillStyle = "#ff3b5c";
          ctx.font = "14px var(--font-jetbrains)";
          ctx.fillText(
            `${obs.distance.toFixed(1)}m`,
            obs.x,
            obs.y - 5
          );
        });
      }

      // Draw target waypoint
      if (showWaypoints) {
        const { x, y, label } = targetWaypoint;

        // Crosshair
        ctx.strokeStyle = "#00ff88";
        ctx.lineWidth = 2;
        const size = 20;
        ctx.beginPath();
        ctx.moveTo(x - size, y);
        ctx.lineTo(x + size, y);
        ctx.moveTo(x, y - size);
        ctx.lineTo(x, y + size);
        ctx.stroke();

        // Center circle
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.stroke();

        // Label
        ctx.fillStyle = "#00ff88";
        ctx.font = "14px var(--font-jetbrains)";
        ctx.fillText(label, x + 15, y - 15);
      }

      animationFrameId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [obstacles, plannedPath, targetWaypoint, showObstacles, showPath, showWaypoints]);

  return (
    <div className="relative inline-block">
      {/* MJPEG Stream */}
      <img
        ref={videoRef}
        src={streamUrl}
        alt="Camera Feed"
        className="block rounded-lg"
        style={{
          width: dimensions.width,
          height: dimensions.height,
          backgroundColor: "#000",
        }}
      />

      {/* Canvas Overlay */}
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        className="absolute top-0 left-0 pointer-events-none"
        style={{
          width: dimensions.width,
          height: dimensions.height,
        }}
      />

      {/* Status Indicator */}
      <div className="absolute top-2 right-2 flex items-center gap-2 bg-black/60 px-3 py-1.5 rounded-full backdrop-blur-sm">
        <div
          className={`w-2 h-2 rounded-full ${
            isStreamActive ? "bg-green-500 animate-pulse" : "bg-red-500"
          }`}
        />
        <span className="text-xs font-jetbrains text-white">
          {isStreamActive ? "LIVE" : "OFFLINE"}
        </span>
      </div>

      {/* Legend */}
      <div className="absolute bottom-2 left-2 bg-black/60 px-3 py-2 rounded-lg backdrop-blur-sm space-y-1">
        <div className="flex items-center gap-2">
          <div className="w-4 h-0.5 bg-[#00d4ff]" style={{ borderStyle: "dashed" }} />
          <span className="text-xs font-jetbrains text-white">Planned Path</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-3 border-2 border-[#ff3b5c]" />
          <span className="text-xs font-jetbrains text-white">Obstacles</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-[#00ff88] rounded-full" />
          <span className="text-xs font-jetbrains text-white">Target</span>
        </div>
      </div>
    </div>
  );
}
