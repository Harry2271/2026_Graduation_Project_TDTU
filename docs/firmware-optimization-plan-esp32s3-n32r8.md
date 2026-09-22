# ESP32-S3-WROOM-2-N32R8V Firmware Optimization Plan

## Executive Summary

**Hardware:** ESP32-S3-WROOM-2-N32R8V (32MB Flash + 8MB PSRAM)
**Current:** WeAct N16R8 (16MB Flash + 8MB PSRAM) running production firmware since July 2026
**Goal:** Maximize real-time performance, minimize latency, leverage dual-core + PSRAM for future-proof expansion

**Recommendation:** OPTIMIZE existing ESP32-S3 firmware instead of migrating to STM32. See [ESP32 vs STM32 Analysis](#appendix-a-esp32-vs-stm32-comparison) for the full cost/benefit breakdown.

---

## 1. Hardware Upgrade: N16R8 → N32R8V

| Feature | N16R8 (current) | N32R8V (target) | Benefit |
|---|---|---|---|
| Flash | 16MB | 32MB | 2× space for OTA dual-partition, larger logging buffers, future vision/ML |
| PSRAM | 8MB Octal | 8MB Octal | Same capacity, same speed |
| Cost delta | — | +$2-3/unit | Marginal |

**Migration effort:** Zero firmware changes required — same GPIO, same chip variant (ESP32-S3-WROOM-2), only flash size differs. Update `platformio.ini` partition table to use 16MB app partitions (OTA A/B) + 8MB SPIFFS for map/log storage.

---

## 2. Current Firmware Performance Baseline

From `firmware/src/main.cpp`, `config.h`, and memory analysis:

| Metric | Current | Target | Headroom |
|---|---|---|---|
| PID loop rate | 50 Hz (20ms) | 100 Hz (10ms) | 2× faster response |
| IMU telemetry | 20 Hz (50ms) | 50 Hz (20ms) | Nav2 odometry standard |
| I2C transaction | 100 kHz, blocking | 400 kHz, DMA | 4× throughput |
| UART JSON parse | Blocking `Serial.readStringUntil()` | DMA ring buffer | Zero main-loop stall |
| PWM resolution | 10-bit (1024) | 12-bit (4096) | 4× finer motor control |
| CPU load (est.) | ~40% single-core | <60% dual-core | 20% reserve for vision |
| PSRAM usage | 0 (unused) | 2-4MB active | Sensor fusion buffers |

---

## 3. Optimization Strategy: 6-Phase Roadmap

### Phase 0: Pre-Flight (1 day)
- Inventory current firmware modules (`firmware/src/modules/*.cpp`)
- Benchmark PID loop jitter, I2C transaction time, UART parse latency
- Establish performance baselines (CSV log for before/after comparison)

### Phase 1: FreeRTOS Task Refactor (3 days)
**Goal:** Isolate real-time PID loop from I2C/UART/telemetry I/O

