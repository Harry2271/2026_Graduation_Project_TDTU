import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import { useMapStore } from '@/store/useMapStore';

type Props = {
  size: number;
  range?: number;
  lidarAxis?: number;
};

const MAX_POINTS = 360;
const DOT_RADIUS = 1.6;

function applyAxis(x: number, y: number, axis: number): { rx: number; ry: number } {
  switch (axis) {
    case 0: return { rx:  x, ry:  y };
    case 1: return { rx:  y, ry: -x };
    case 2: return { rx: -x, ry: -y };
    case 3: return { rx: -y, ry:  x };
    default: return { rx: x, ry: y };
  }
}

function rotate(x: number, y: number, theta: number): { x: number; y: number } {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: c * x - s * y, y: s * x + c * y };
}

/**
 * Build SVG-native coordinate arrays for all scan points.
 * Each dot becomes an SVG <Circle>.  A single `<Svg>` element holds
 * everything — this is the only view node sent to the RN bridge
 * per render (plus one `<Circle>` per dot, but these are native SVG
 * elements inside a single native view, so the bridge cost is minimal
 * compared to individual RN Views).
 */
type ScanDots = { cx: string; cy: string };

function computeScanDots(
  scanData: { points: { x: number; y: number }[] } | null,
  pose: { x: number; y: number; theta: number } | null,
  lidarAxis: number,
  scale: number,
  center: number,
  size: number,
): ScanDots[] {
  if (!scanData?.points.length) return [];
  const stride = Math.max(1, Math.floor(scanData.points.length / MAX_POINTS));
  const out: ScanDots[] = [];
  for (let i = 0; i < scanData.points.length; i += stride) {
    const pt = scanData.points[i];
    const local = applyAxis(pt.x, pt.y, lidarAxis);
    const world = pose
      ? rotate(local.rx, local.ry, pose.theta)
      : { x: local.rx, y: local.ry };
    const sx = center + world.x * scale;
    const sy = center - world.y * scale;
    if (sx < -DOT_RADIUS || sx > size + DOT_RADIUS) continue;
    if (sy < -DOT_RADIUS || sy > size + DOT_RADIUS) continue;
    // Pre-format to 2 decimal places to avoid string building during render
    out.push({ cx: sx.toFixed(1), cy: sy.toFixed(1) });
  }
  return out;
}

export const MapCanvas = memo(function MapCanvas({
  size,
  range = 6,
  lidarAxis = 1,
}: Props) {
  const pose = useMapStore((s) => s.pose);
  const scanData = useMapStore((s) => s.scanData);

  const scale = (size / 2 - 8) / range;
  const center = size / 2;

  const scanDots = useMemo(
    () => computeScanDots(scanData, pose, lidarAxis, scale, center, size),
    [scanData, pose, lidarAxis, scale, center, size],
  );

  const rings = useMemo(() => {
    const out: number[] = [];
    for (let r = 1; r <= 3; r++) out.push((r * range) / 3);
    return out;
  }, [range]);

  const robotLeft = center - 6;
  const robotTop = center - 6;

  // Robot direction arrow end points (10px forward, rotated by pose.theta)
  const arrowLen = 10;
  const arrowBx = center + (pose ? Math.cos(pose.theta) : 1) * arrowLen;
  const arrowBy = center - (pose ? Math.sin(pose.theta) : 0) * arrowLen;

  return (
    <View style={[styles.root, { width: size, height: size }]}>
      {/* Dark radar background */}
      <View style={[styles.bg, { width: size, height: size }]} />

      {/* SVG layer — rings, scan dots, robot marker, all native */}
      <Svg width={size} height={size} style={styles.svg}>
        {/* Range rings */}
        {rings.map((r, i) => {
          const cx = center;
          const cy = center;
          return (
            <Circle
              key={`ring-${i}`}
              cx={cx}
              cy={cy}
              r={r * scale}
              fill="none"
              stroke="rgba(0,212,255,0.18)"
              strokeWidth={1}
            />
          );
        })}

        {/* Crosshair */}
        <Line x1={center} y1={0} x2={center} y2={size} stroke="rgba(0,212,255,0.12)" strokeWidth={0.5} />
        <Line x1={0} y1={center} x2={size} y2={center} stroke="rgba(0,212,255,0.12)" strokeWidth={0.5} />

        {/* Scan dots */}
        {scanDots.map((dot, i) => (
          <Circle
            key={i}
            cx={dot.cx}
            cy={dot.cy}
            r={DOT_RADIUS}
            fill="rgba(0,212,255,0.85)"
          />
        ))}

        {/* Robot marker (green dot) */}
        <Circle
          cx={center}
          cy={center}
          r={6}
          fill="#00ff88"
          fillOpacity={0.9}
        />
        {/* Robot ring */}
        <Circle
          cx={center}
          cy={center}
          r={6}
          fill="none"
          stroke="#ffffff"
          strokeWidth={2}
          strokeOpacity={0.7}
        />

        {/* Direction arrow */}
        <Line
          x1={center}
          y1={center}
          x2={arrowBx}
          y2={arrowBy}
          stroke="#ff3b5c"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,212,255,0.35)',
  },
  bg: {
    position: 'absolute',
    backgroundColor: 'rgba(8,11,16,0.95)',
  },
  svg: {
    position: 'absolute',
  },
});
