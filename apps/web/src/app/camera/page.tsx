'use client';

import { useState } from 'react';
import { Camera, Wifi, WifiOff, Maximize2, Minimize2, Volume2, VolumeX, RefreshCw } from 'lucide-react';

export default function CameraPage() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const isOnline = false;

  const handleToggleFullscreen = () => {
    if (!isFullscreen) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
    setIsFullscreen(!isFullscreen);
  };

  return (
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={{ background: 'var(--bg-void)', fontFamily: "'JetBrains Mono', system-ui" }}
    >
      {/* ─── Header ─────────────────────────────────────── */}
      <div
        className="px-8 py-5 relative overflow-hidden"
        style={{
          background: 'linear-gradient(180deg, rgba(255,59,92,0.04) 0%, transparent 100%)',
          borderBottom: '1px solid var(--border-dim)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
        }}
      >
        <div className="absolute inset-0 pointer-events-none" />
        <div className="flex justify-between items-start relative z-10 flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <Camera size={22} style={{ color: 'var(--danger)' }} />
              <h1
                className="text-display text-xl"
                style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', letterSpacing: '-0.02em' }}
              >
                CAMERA ROBOT
              </h1>
              <span
                className="text-[9px] font-bold px-2 py-1 rounded-md"
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

          <div className="flex items-center gap-3">
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
                1920×1080 @ 30fps
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Video area ─────────────────────────────────── */}
      <div className="flex-1 min-h-0 p-6 flex flex-col gap-4">

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
          <div className="absolute top-5 left-5 w-10 h-10 border-l-2 border-t-2 rounded-tl z-20 pointer-events-none" style={{ borderColor: 'rgba(255,59,92,0.4)' }} />
          <div className="absolute top-5 right-5 w-10 h-10 border-r-2 border-t-2 rounded-tr z-20 pointer-events-none" style={{ borderColor: 'rgba(255,59,92,0.4)' }} />
          <div className="absolute bottom-5 left-5 w-10 h-10 border-l-2 border-b-2 rounded-bl z-20 pointer-events-none" style={{ borderColor: 'rgba(255,59,92,0.4)' }} />
          <div className="absolute bottom-5 right-5 w-10 h-10 border-r-2 border-b-2 rounded-br z-20 pointer-events-none" style={{ borderColor: 'rgba(255,59,92,0.4)' }} />

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
              {new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>

          {/* Controls overlay at bottom */}
          <div
            className="absolute bottom-4 right-4 z-20 flex items-center gap-2 p-1.5 rounded-2xl"
            style={{
              background: 'rgba(8,11,16,0.85)',
              backdropFilter: 'blur(12px)',
              border: '1px solid var(--border-mid)',
            }}
          >
            <button
              onClick={() => setIsMuted(!isMuted)}
              title={isMuted ? 'Bật âm thanh' : 'Tắt âm thanh'}
              className="w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer"
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
              className="w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-dim)', color: 'var(--text-secondary)' }}
            >
              {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>

            <button
              onClick={() => { setIsConnecting(true); setTimeout(() => setIsConnecting(false), 2000); }}
              title="Kết nối lại"
              className="w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-dim)', color: 'var(--text-secondary)' }}
            >
              <RefreshCw size={18} className={isConnecting ? 'animate-spin' : ''} />
            </button>
          </div>

          {/* Center content: offline state */}
          <div className="absolute inset-0 flex items-center justify-center z-30">
            <div className="text-center">
              {/* Large icon */}
              <div
                className="w-24 h-24 rounded-3xl mx-auto mb-6 flex items-center justify-center"
                style={{
                  background: 'linear-gradient(135deg, rgba(255,59,92,0.08), rgba(255,59,92,0.02))',
                  border: '1px solid rgba(255,59,92,0.15)',
                  boxShadow: '0 0 40px rgba(255,59,92,0.08)',
                }}
              >
                <Camera size={44} style={{ color: 'rgba(255,59,92,0.4)' }} />
              </div>

              <h2
                className="text-xl font-black mb-2"
                style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', letterSpacing: '-0.02em' }}
              >
                Camera Robot — Chưa kết nối
              </h2>
              <p
                className="text-sm max-w-sm mx-auto"
                style={{ color: 'var(--text-muted)', lineHeight: 1.6, fontFamily: "'JetBrains Mono', monospace" }}
              >
                Luồng video từ camera gắn trên tay robot sẽ hiển thị tại đây khi kết nối WebSocket thành công với ROS.
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
                  ws://robot.local:9090/camera/compressed
                </span>
              </div>
            </div>
          </div>

          {/* Video element (hidden when offline) */}
          {/* <video ref={videoRef} autoPlay playsInline muted={isMuted} className="absolute inset-0 w-full h-full object-cover" /> */}
        </div>
      </div>

    </div>
  );
}
