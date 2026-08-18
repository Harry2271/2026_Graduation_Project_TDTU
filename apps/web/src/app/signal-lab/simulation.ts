export type PidScene = 'step' | 'tracking' | 'compare';
export type LidarScene = 'room' | 'corridor' | 'cluttered';

export interface PidGains { kp: number; ki: number; kd: number; }
export interface PidSeries { time: number[]; target: number[]; actual: number[]; error: number[]; pwm: number[]; }
export interface PidStats { overshootPct: number; riseMs: number; settlingMs: number; steadyStateError: number; }
export interface LidarPoint { degree: number; distance: number; }
export interface LidarZones { front: number; left: number; right: number; rear: number; }

export const defaultGains: PidGains = { kp: 2.5, ki: 0.2, kd: 0.05 };

export function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }

function targetFor(scene: PidScene, time: number): number {
  if (scene === 'tracking') return 120 + 80 * Math.sin(time * 3) + 40 * Math.sin(time * 7);
  return time < 0.3 ? 0 : 200;
}

export function simulatePid(gains: PidGains, scene: PidScene): PidSeries {
  const series: PidSeries = { time: [], target: [], actual: [], error: [], pwm: [] };
  const dt = 0.02;
  let actual = 0;
  let integral = 0;
  let previousError = 0;
  for (let index = 0; index <= 100; index += 1) {
    const time = index * dt;
    const target = targetFor(scene, time);
    const error = target - actual;
    integral = clamp(integral + error * dt, -400, 400);
    const derivative = (error - previousError) / dt;
    const output = clamp(gains.kp * error + gains.ki * integral + gains.kd * derivative, -511, 511);
    const deterministicNoise = Math.sin(index * 2.41) * 0.65 + Math.sin(index * 0.73) * 0.35;
    actual = clamp(actual + output * 0.016 + deterministicNoise, 0, 400);
    previousError = error;
    series.time.push(time); series.target.push(target); series.actual.push(actual); series.error.push(target - actual); series.pwm.push(Math.abs(output));
  }
  return series;
}

export function getPidStats(series: PidSeries): PidStats {
  const finalTarget = series.target.at(-1) ?? 0;
  const maximum = Math.max(...series.actual);
  const overshootPct = finalTarget ? Math.max(0, ((maximum - finalTarget) / finalTarget) * 100) : 0;
  const riseIndex = series.actual.findIndex((value) => value >= finalTarget * 0.9);
  let settlingIndex = series.time.length - 1;
  for (let index = series.actual.length - 1; index >= 0; index -= 1) {
    if (Math.abs(series.actual[index] - finalTarget) > finalTarget * 0.02) { settlingIndex = Math.min(index + 1, series.time.length - 1); break; }
  }
  const latest = series.actual.slice(-10);
  const average = latest.reduce((total, value) => total + value, 0) / latest.length;
  return { overshootPct, riseMs: Math.max(0, riseIndex) * 20, settlingMs: settlingIndex * 20, steadyStateError: Math.abs(finalTarget - average) };
}

function boundedRoom(degree: number, forward: number, side: number): number {
  const radians = degree * Math.PI / 180;
  const cos = Math.cos(radians); const sin = Math.sin(radians);
  const distances = [cos > 0.01 ? forward / cos : Infinity, cos < -0.01 ? forward / -cos : Infinity, sin > 0.01 ? side / sin : Infinity, sin < -0.01 ? side / -sin : Infinity];
  return Math.min(...distances);
}

export function generateLidar(scene: LidarScene): LidarPoint[] {
  return Array.from({ length: 360 }, (_, degree) => {
    let distance = scene === 'room' ? boundedRoom(degree, 2, 1.5) : scene === 'corridor' ? boundedRoom(degree, 4, 0.6) : boundedRoom(degree, 2.5, 2);
    const angleDistance = (target: number) => Math.min(Math.abs(degree - target), 360 - Math.abs(degree - target));
    if (scene === 'room') { if (angleDistance(30) < 15) distance = Math.min(distance, 1); if (angleDistance(110) < 12) distance = Math.min(distance, 1.4); }
    if (scene === 'corridor' && angleDistance(0) < 9) distance = Math.min(distance, 1.85);
    if (scene === 'cluttered') for (const obstacle of [{ degree: 20, distance: 0.8 }, { degree: 60, distance: 1.2 }, { degree: 150, distance: 0.6 }, { degree: 200, distance: 1.5 }, { degree: 300, distance: 0.9 }, { degree: 340, distance: 1.1 }]) if (angleDistance(obstacle.degree) < 10) distance = Math.min(distance, obstacle.distance);
    return { degree, distance: clamp(distance + Math.sin(degree * 1.73) * 0.045, 0.15, 12) };
  });
}

export function getLidarZones(points: LidarPoint[]): LidarZones {
  const zones: LidarZones = { front: Infinity, left: Infinity, right: Infinity, rear: Infinity };
  for (const point of points) {
    if (point.degree >= 315 || point.degree <= 45) zones.front = Math.min(zones.front, point.distance);
    else if (point.degree <= 135) zones.left = Math.min(zones.left, point.distance);
    else if (point.degree <= 225) zones.rear = Math.min(zones.rear, point.distance);
    else zones.right = Math.min(zones.right, point.distance);
  }
  return zones;
}
