'use client';

import { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, Box } from '@react-three/drei';
import * as THREE from 'three';
import { getRobotSocket } from '@/lib/robotSocket';

// ── IMU Data Interface (ESP32 type 134) ──────────────────────────────────────

interface ImuData {
  yaw: number;
  pitch: number;
  roll: number;
  temp?: number;
  cal?: {
    sys: number;
    gyro: number;
    accel: number;
    mag: number;
  };
}

// ── Robot Mesh Component ─────────────────────────────────────────────────────

interface RobotMeshProps {
  imuData: ImuData | null;
}

function RobotMesh({ imuData }: RobotMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (!meshRef.current || !imuData) return;

    // Apply Euler angles from IMU (BNO055 outputs in degrees)
    // Convert to radians and apply to mesh rotation
    const yawRad = (imuData.yaw * Math.PI) / 180;
    const pitchRad = (imuData.pitch * Math.PI) / 180;
    const rollRad = (imuData.roll * Math.PI) / 180;

    // Apply rotation using Euler angles (ZYX order for robotics)
    meshRef.current.rotation.set(pitchRad, yawRad, rollRad, 'ZYX');
  });

  return (
    <group>
      {/* Main AGV body (box representing the robot chassis) */}
      <Box ref={meshRef} args={[1.2, 0.3, 0.8]}>
        <meshStandardMaterial color="#2196f3" />
      </Box>

      {/* Front indicator (red box to show forward direction) */}
      <Box position={[0.7, 0, 0]} args={[0.2, 0.2, 0.2]}>
        <meshStandardMaterial color="#f44336" />
      </Box>

      {/* Axis helpers on the robot body */}
      <axesHelper args={[1]} />
    </group>
  );
}

// ── Scene Component ──────────────────────────────────────────────────────────

interface SceneProps {
  imuData: ImuData | null;
}

function Scene({ imuData }: SceneProps) {
  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 5]} intensity={1} />
      <pointLight position={[-10, -10, -5]} intensity={0.5} />

      {/* Grid floor */}
      <Grid
        args={[20, 20]}
        cellSize={0.5}
        cellThickness={0.5}
        cellColor="#6b7280"
        sectionSize={2}
        sectionThickness={1}
        sectionColor="#374151"
        fadeDistance={30}
        fadeStrength={1}
        position={[0, -0.15, 0]}
      />

      {/* Robot mesh */}
      <RobotMesh imuData={imuData} />

      {/* Orbit controls */}
      <OrbitControls
        enableDamping
        dampingFactor={0.05}
        minDistance={2}
        maxDistance={20}
        maxPolarAngle={Math.PI / 2}
      />
    </>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export interface Robot3DViewProps {
  width?: string | number;
  height?: string | number;
  className?: string;
}

export default function Robot3DView({
  width = '100%',
  height = 400,
  className,
}: Robot3DViewProps) {
  const [imuData, setImuData] = useState<ImuData | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');

  useEffect(() => {
    const robotSocket = getRobotSocket();

    const onImu = (data: unknown) => {
      setImuData(data as ImuData);
    };

    const onConnected = () => setWsStatus('connected');
    const onDisconnected = () => setWsStatus('disconnected');

    robotSocket.on('esp32_imu', onImu);
    robotSocket.on('connected', onConnected);
    robotSocket.on('disconnected', onDisconnected);

    setWsStatus(robotSocket.isConnected() ? 'connected' : 'connecting');

    return () => {
      robotSocket.off('esp32_imu', onImu);
      robotSocket.off('connected', onConnected);
      robotSocket.off('disconnected', onDisconnected);
    };
  }, []);

  return (
    <div
      className={className}
      style={{
        width,
        height,
        position: 'relative',
        background: 'linear-gradient(to bottom, #1a1a1a, #0a0a0a)',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      {/* Status indicator */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          zIndex: 10,
          padding: '6px 12px',
          borderRadius: '6px',
          background: 'rgba(0, 0, 0, 0.7)',
          color: wsStatus === 'connected' ? '#4ade80' : '#f87171',
          fontSize: '12px',
          fontWeight: 500,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: wsStatus === 'connected' ? '#4ade80' : '#f87171',
          }}
        />
        {wsStatus === 'connected' ? 'Đã kết nối' : wsStatus === 'connecting' ? 'Đang kết nối...' : 'Mất kết nối'}
      </div>

      {/* IMU data overlay */}
      {imuData && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 10,
            padding: '8px 12px',
            borderRadius: '6px',
            background: 'rgba(0, 0, 0, 0.7)',
            color: '#e5e7eb',
            fontSize: '11px',
            fontFamily: 'monospace',
            lineHeight: 1.6,
          }}
        >
          <div>Yaw: {imuData.yaw.toFixed(1)}°</div>
          <div>Pitch: {imuData.pitch.toFixed(1)}°</div>
          <div>Roll: {imuData.roll.toFixed(1)}°</div>
          {imuData.temp !== undefined && (
            <div style={{ marginTop: 4, opacity: 0.7 }}>
              Temp: {imuData.temp.toFixed(1)}°C
            </div>
          )}
          {imuData.cal && (
            <div style={{ marginTop: 4, opacity: 0.7, fontSize: '10px' }}>
              Cal: S{imuData.cal.sys} G{imuData.cal.gyro} A{imuData.cal.accel} M{imuData.cal.mag}
            </div>
          )}
        </div>
      )}

      {/* Three.js Canvas */}
      <Canvas
        camera={{
          position: [3, 2, 3],
          fov: 50,
        }}
        style={{ width: '100%', height: '100%' }}
      >
        <Scene imuData={imuData} />
      </Canvas>

      {/* No data placeholder */}
      {!imuData && wsStatus === 'connected' && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#9ca3af',
            fontSize: '14px',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          Đang chờ dữ liệu IMU...
        </div>
      )}
    </div>
  );
}
