'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, Wifi, WifiOff, Maximize2, Minimize2, Volume2, VolumeX, RefreshCw } from 'lucide-react';

const CAMERA_STREAM_URL = process.env.NEXT_PUBLIC_CAMERA_STREAM_URL || 'https://cam.nguyen-robot.io.vn/stream';
const CAMERA_HEALTH_URL = CAMERA_STREAM_URL.replace('/stream', '/');

export default function CameraPage() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const [timestamp, setTimestamp] = useState(new Date());
  const [resolution, setResolution] = useState('—');
  const imgRef = useRef<HTMLImageElement>(null);
  const [streamSrc, setStreamSrc] = useState(CAMERA_STREAM_URL);

  // Poll health endpoint every 5s to update isOnline + resolution
  useEffect(() => {
    const checkHealth = async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(CAMERA_HEALTH_URL, {
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          setIsOnline(data.camera === true);
          if (data.resolution) setResolution(data.resolution);
        } else {
          setIsOnline(false);
        }
      } catch {
        setIsOnline(false);
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  // Update timestamp every second when online
  useEffect(() => {
    if (!isOnline) return;
    const interval = setInterval(() => setTimestamp(new Date()), 1000);
    return () => clearInterval(interval);
  }, [isOnline]);

  const handleToggleFullscreen = useCallback(() => {
    if (!isFullscreen) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
    setIsFullscreen(!isFullscreen);
  }, [isFullscreen]);

  const handleReconnect = useCallback(() => {
    setIsConnecting(true);
    // Force-reload MJPEG stream by busting cache with timestamp
    setStreamSrc(`${CAMERA_STREAM_URL}?t=${Date.now()}`);
    setTimeout(() => setIsConnecting(false), 2000);
  }, []);

  return (
    <div
      className="flex flex-col min-h-dvh overflow-hidden"
      style={{ background: 'var(--bg-void)', fontFamily: "'JetBrains Mono', system-ui" }}
    >
      {/* ─── Header ─────────────────────────────────────── */}
      <div
        className="px-4 md:px-8 py-4 md:py-5 relative overflow-hidden"
        style={{
          background: 'linear-gradient(180deg, rgba(255,59,92,0.04) 0%, transparent 100%)',
          borderBottom: '1px solid var(--border-dim)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
        }}
      >
        <div className="absolute inset-0 pointer-events-none" />
        <div className="flex flex-col md:flex-row md:justify-between md:items-start relative z-10 flex-wrap gap-3 md:gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <Camera size={22} style={{ color: 'var(--danger)' }} />
              <h1
                className="text-display text-xl"
                style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', letterSpacing: '-0.02em' }}
              >
                CAMERA ROBOT
              </h1>
              {/* Mobile compact dot */}
              <span
                className="md:hidden w-2 h-2 rounded-full"
                style={{
                  background: isOnline ? 'var(--success)' : 'var(--danger)',
                  boxShadow: isOnline ? '0 0 6px var(--success-glow)' : 'none',
                }}
              />
              <span
                className="hidden md:inline-block text-[9px] font-bold px-2 py-1 rounded-md"
                style={{
                  background: isOnline ? 'rgba(0,255,136,0.1)' : 'rgba(255,59,92,0.1)',
                  border: `1px solid ${isOnline ? 'rgba(0,255,136,0.25)' : 'rgba(255,59,92,0.25)'}`,
                  color: isOnline ? 'var(--success)' : 'var(--danger)',
                  fontFamily: "'JetBrains Mono', monospace",
                  letterSpacing: '0.1em',
                }}
              >
                {isOnline ? 'STREAMING' : 'OFFLINE'}
              </span>
            </div>
            <p
              className="text-xs"
              style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em' }}
            >
              Luồng hình ảnh từ camera gắn trên tay robot — Đồ án Tốt nghiệp TDTU
            </p>
          </div>

          <div className="hidden md:flex items-center gap-3">
            {/* Status */}
            <div
              className="flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-bold border"
              style={
                isOnline
                  ? { background: 'rgba(0,255,136,0.08)', borderColor: 'rgba(0,255,136,0.2)', color: 'var(--success)' }
                  : { background: 'rgba(255,59,92,0.08)', borderColor: 'rgba(255,59,92,0.2)', color: 'var(--danger)' }
              }
            >
              {isOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
              {isOnline ? 'Đang kết nối' : 'Mất kết nối'}
            </div>

            {/* Resolution */}
            <div
              className="px-3.5 py-2.5 rounded-2xl text-xs font-mono font-bold border"
              style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-dim)', color: 'var(--text-muted)' }}
            >
              <span style={{ color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>
                {resolution}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Video area ─────────────────────────────────── */}
      <div className="flex-1 min-h-0 p-3 md:p-6 flex flex-col gap-3 md:gap-4">

        {/* Main viewport */}
        <div
          className="flex-1 relative rounded-3xl overflow-hidden min-h-0"
          style={{
            background: 'var(--bg-base)',
            border: '1px solid var(--border-dim)',
            boxShadow: '0 8px 48px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)',
          }}
        >
          {/* Scan-line overlay */}
          <div
            className="absolute inset-0 pointer-events-none z-10"
            style={{
              background: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.04) 3px, rgba(0,0,0,0.04) 6px)',
              borderRadius: 'inherit',
            }}
          />

          {/* Corner brackets */}
          <div className="absolute top-3 left-3 w-6 h-6 md:top-5 md:left-5 md:w-10 md:h-10 border-l-2 border-t-2 rounded-tl z-20 pointer-events-none" style={{ borderColor: 'rgba(255,59,92,0.4)' }} />
          <div className="absolute top-3 right-3 w-6 h-6 md:top-5 md:right-5 md:w-10 md:h-10 border-r-2 border-t-2 rounded-tr z-20 pointer-events-none" style={{ borderColor: 'rgba(255,59,92,0.4)' }} />
          <div className="absolute bottom-3 left-3 w-6 h-6 md:bottom-5 md:left-5 md:w-10 md:h-10 border-l-2 border-b-2 rounded-bl z-20 pointer-events-none" style={{ borderColor: 'rgba(255,59,92,0.4)' }} />
          <div className="absolute bottom-3 right-3 w-6 h-6 md:bottom-5 md:right-5 md:w-10 md:h-10 border-r-2 border-b-2 rounded-br z-20 pointer-events-none" style={{ borderColor: 'rgba(255,59,92,0.4)' }} />

          {/* Camera info badge */}
          <div
            className="absolute top-4 right-4 z-20 flex items-center gap-2 px-3 py-2 rounded-xl"
            style={{
              background: 'rgba(8,11,16,0.85)',
              backdropFilter: 'blur(12px)',
              border: '1px solid var(--border-mid)',
            }}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: isOnline ? 'var(--success)' : 'var(--danger)', boxShadow: isOnline ? '0 0 8px var(--success-glow)' : 'none' }}
            />
            <span className="text-[10px] font-bold" style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.08em' }}>
              CAM-01 · ARM_MOUNT
            </span>
          </div>

          {/* Timestamp */}
          <div
            className="absolute bottom-4 left-4 z-20 px-3 py-1.5 rounded-lg"
            style={{
              background: 'rgba(8,11,16,0.75)',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--border-dim)',
            }}
          >
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
              {timestamp.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>

          {/* Controls overlay at bottom */}
          <div
            className="absolute bottom-3 right-3 md:bottom-4 md:right-4 z-20 flex items-center gap-1.5 md:gap-2 p-1.5 rounded-2xl"
            style={{
              background: 'rgba(8,11,16,0.85)',
              backdropFilter: 'blur(12px)',
              border: '1px solid var(--border-mid)',
            }}
          >
            <button
              onClick={() => setIsMuted(!isMuted)}
              title={isMuted ? 'Bật âm thanh' : 'Tắt âm thanh'}
              className="w-9 h-9 md:w-10 md:h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer"
              style={{
                background: isMuted ? 'rgba(255,59,92,0.15)' : 'var(--bg-raised)',
                border: '1px solid',
                borderColor: isMuted ? 'rgba(255,59,92,0.25)' : 'var(--border-dim)',
                color: isMuted ? 'var(--danger)' : 'var(--text-secondary)',
              }}
            >
              {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>

            <button
              onClick={handleToggleFullscreen}
              title={isFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
              className="w-9 h-9 md:w-10 md:h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-dim)', color: 'var(--text-secondary)' }}
            >
              {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>

            <button
              onClick={handleReconnect}
              title="Kết nối lại"
              className="w-9 h-9 md:w-10 md:h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-dim)', color: 'var(--text-secondary)' }}
            >
              <RefreshCw size={18} className={isConnecting ? 'animate-spin' : ''} />
            </button>
          </div>

          {/* MJPEG Stream — <img> tag handles multipart/x-mixed-replace natively */}
          {isOnline && (
            <img
              ref={imgRef}
              src={streamSrc}
              alt="Camera stream"
              className="absolute inset-0 w-full h-full object-cover"
              style={{ imageRendering: 'auto' }}
            />
          )}

          {/* Center content: offline state */}
          {!isOnline && (
            <div className="absolute inset-0 flex items-center justify-center z-30">
              <div className="text-center">
                {/* Large icon */}
                <div
                  className="w-20 h-20 md:w-24 md:h-24 rounded-3xl mx-auto mb-4 md:mb-6 flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(135deg, rgba(255,59,92,0.08), rgba(255,59,92,0.02))',
                    border: '1px solid rgba(255,59,92,0.15)',
                    boxShadow: '0 0 40px rgba(255,59,92,0.08)',
                  }}
                >
                  <Camera size={44} style={{ color: 'rgba(255,59,92,0.4)' }} />
                </div>

                <h2
                  className="text-lg md:text-xl font-black mb-2"
                  style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', letterSpacing: '-0.02em' }}
                >
                  Camera Robot — Chưa kết nối
                </h2>
                <p
                  className="text-xs md:text-sm max-w-sm mx-auto px-4"
                  style={{ color: 'var(--text-muted)', lineHeight: 1.6, fontFamily: "'JetBrains Mono', monospace" }}
                >
                  Luồng video từ camera gắn trên tay robot sẽ hiển thị tại đây khi camera node hoạt động.
                </p>

                {/* Connection info */}
                <div
                  className="mt-6 inline-flex items-center gap-3 px-5 py-3 rounded-2xl"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-dim)',
                  }}
                >
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ background: 'var(--danger)', boxShadow: '0 0 8px var(--danger-glow)' }}
                  />
                  <span className="text-xs font-mono" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                    {CAMERA_HEALTH_URL}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
