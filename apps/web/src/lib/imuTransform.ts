/**
 * Quaternion and 3D math utilities for BNO055 trajectory processing.
 *
 * The BNO055 emits orientation as a quaternion (w, x, y, z) on register 0x20
 * with a fixed-point scale of 1/2^14 (1/16384.0).  The sensor's onboard fusion
 * already subtracts gravity from the accelerometer, so VECTOR_LINEARACCEL gives
 * a clean body-frame acceleration in m/s^2.  We need three transforms to turn
 * that into a world-frame path:
 *
 *   1. q-rotate: body-frame accel -> earth-frame accel using the native
 *      body-to-world quaternion
 *   2. subtract gravity (BNO055 does this for us, but keep the hook for raw accel)
 *   3. integrate: accel -> velocity -> position (with ZUPT correction)
 *
 * Drift is intrinsic to double integration; a 5-second straight-line traverse at
 * 1 m/s drifts by ~1-5 m on the CJMCU-055 clone.  ZUPT (Zero Velocity Update)
 * snaps velocity to zero whenever the robot is stationary, which is how the
 * Pi/warehouse robot spends most of its time.
 */

export type Quaternion = [number, number, number, number] // w, x, y, z
export type Vec3 = [number, number, number]

export function normalizeQuat(q: Quaternion): Quaternion | null {
  if (!q.every(Number.isFinite)) return null
  const norm = Math.hypot(q[0], q[1], q[2], q[3])
  if (!Number.isFinite(norm) || norm < 1e-6) return null
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm]
}

/** Rotate a body-frame vector into the world frame. */
export function bodyToWorld(qBodyToWorld: Quaternion, v: Vec3): Vec3 {
  return quatRotateVec(qBodyToWorld, v)
}

/** Quaternion multiplication q1 * q2 (Hamilton product). */
export function quatMul(a: Quaternion, b: Quaternion): Quaternion {
  const [w1, x1, y1, z1] = a
  const [w2, x2, y2, z2] = b
  return [
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
  ]
}

/** Quaternion conjugate (inverse for unit quaternions). */
export function quatConj(q: Quaternion): Quaternion {
  return [q[0], -q[1], -q[2], -q[3]]
}

/**
 * Rotate a 3D vector by a quaternion: v' = q * (0, v) * q^-1.
 * Used to take body-frame accelerometer readings into the world frame.
 */
export function quatRotateVec(q: Quaternion, v: Vec3): Vec3 {
  const qv: Quaternion = [0, v[0], v[1], v[2]]
  const r = quatMul(quatMul(q, qv), quatConj(q))
  return [r[1], r[2], r[3]]
}

/** Convert quaternion to a 3x3 rotation matrix (column-major, Three.js friendly). */
export function quatToMat3(q: Quaternion): number[] {
  const [w, x, y, z] = q
  const xx = x * x,
    yy = y * y,
    zz = z * z
  const xy = x * y,
    xz = x * z,
    yz = y * z
  const wx = w * x,
    wy = w * y,
    wz = w * z
  return [
    1 - 2 * (yy + zz),
    2 * (xy + wz),
    2 * (xz - wy),
    2 * (xy - wz),
    1 - 2 * (xx + zz),
    2 * (yz + wx),
    2 * (xz + wy),
    2 * (yz - wx),
    1 - 2 * (xx + yy),
  ]
}

/** Spherical-linear interpolation between two unit quaternions. */
export function quatSlerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  let [w1, x1, y1, z1] = a
  let [w2, x2, y2, z2] = b
  let cosHalf = w1 * w2 + x1 * x2 + y1 * y2 + z1 * z2
  if (cosHalf < 0) {
    w2 = -w2
    x2 = -x2
    y2 = -y2
    z2 = -z2
    cosHalf = -cosHalf
  }
  if (cosHalf >= 1.0) return [w1, x1, y1, z1]
  const halfAngle = Math.acos(cosHalf)
  const sinHalf = Math.sin(halfAngle)
  if (sinHalf < 1e-6) {
    return [
      w1 * (1 - t) + w2 * t,
      x1 * (1 - t) + x2 * t,
      y1 * (1 - t) + y2 * t,
      z1 * (1 - t) + z2 * t,
    ]
  }
  const ratioA = Math.sin((1 - t) * halfAngle) / sinHalf
  const ratioB = Math.sin(t * halfAngle) / sinHalf
  return [
    w1 * ratioA + w2 * ratioB,
    x1 * ratioA + x2 * ratioB,
    y1 * ratioA + y2 * ratioB,
    z1 * ratioA + z2 * ratioB,
  ]
}

/** Wrap an angle in degrees to [0, 360). */
export function wrapDeg(deg: number): number {
  const x = deg % 360
  return x < 0 ? x + 360 : x
}

/**
 * ZUPT (Zero Velocity Update) test for warehouse robot.
 * True when the chassis is effectively still: gyro magnitude small AND
 * linear-accel magnitude close to gravity (since BNO055 already removed gravity,
 * we expect the residual to be tiny).
 *
 * Body-frame `accel` is in m/s^2 (linear acceleration), `gyro` is in deg/s.
 */
export function isStationary(
  accel: Vec3,
  gyro: Vec3,
  gyroThreshDegPerSec = 3.0,
  accelThreshMs2 = 0.4
): boolean {
  const gyroMag = Math.hypot(gyro[0], gyro[1], gyro[2])
  const accelMag = Math.hypot(accel[0], accel[1], accel[2])
  return gyroMag < gyroThreshDegPerSec && accelMag < accelThreshMs2
}

export interface StationaryDetector {
  update(accel: Vec3, gyro: Vec3, dt: number): boolean
  reset(): void
}

/** Debounces ZUPT transitions so sensor noise cannot flap moving/stopped state. */
export function makeStationaryDetector(
  enterDwellSec = 0.35,
  exitDwellSec = 0.1
): StationaryDetector {
  let stationary = false
  let dwellSec = 0

  return {
    update(accel, gyro, dt) {
      const instant = isStationary(accel, gyro, stationary ? 4.0 : 3.0, stationary ? 0.5 : 0.4)
      dwellSec = instant === stationary ? 0 : dwellSec + Math.max(0, dt)
      const required = stationary ? exitDwellSec : enterDwellSec
      if (instant !== stationary && dwellSec >= required) {
        stationary = instant
        dwellSec = 0
      }
      return stationary
    },
    reset() {
      stationary = false
      dwellSec = 0
    },
  }
}

/**
 * Lightweight exponential low-pass on a quaternion (slerp toward new sample).
 * alpha=0 means "keep old", alpha=1 means "use new".  Callers usually pick
 * 0.3-0.5 to remove BNO055 jitter without lagging real motion.
 */
export function smoothQuat(prev: Quaternion, next: Quaternion, alpha: number): Quaternion {
  return quatSlerp(prev, next, alpha)
}

/**
 * First-order Butterworth-style high-pass on a single-axis signal.
 * `cutoffHz` is the corner frequency; `sampleRate` is the input rate.
 * Used to strip integration drift from the velocity signal.
 *
 * y[n] = a*(y[n-1] + x[n] - x[n-1])
 * where a = RC / (RC + dt), RC = 1/(2*pi*cutoffHz), dt = 1/sampleRate
 */
export function makeHighPass(cutoffHz: number, sampleRate: number) {
  const RC = 1 / (2 * Math.PI * cutoffHz)
  const dt = 1 / sampleRate
  const a = RC / (RC + dt)
  let prevIn = 0
  let prevOut = 0

  return {
    reset: () => {
      prevIn = 0
      prevOut = 0
    },
    filter: (x: number): number => {
      const y = a * (prevOut + x - prevIn)
      prevIn = x
      prevOut = y
      return y
    },
  }
}
