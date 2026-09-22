# Safety Monitoring Flowchart — Robot for Nguyen

## System Overview

Hệ thống giám sát an toàn bao gồm 5 lớp bảo vệ:
1. **Hardware Layer** — IR sensors, Sharp distance sensor, IMU tilt detection
2. **Firmware Layer** — ESP32-S3 real-time obstacle avoidance + E-stop
3. **Communication Layer** — Watchdog + Heartbeat monitoring
4. **ROS Layer** — LiDAR-based obstacle detection on Pi 5
5. **Application Layer** — Brain state machine safety gates

---

## 1. Hardware Safety Layer (ESP32-S3 Firmware)

```
┌─────────────────────────────────────────────────────────────────┐
│                    POWER-ON / BOOT                              │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│               Initialize Safety Modules                         │
│  • I2CBus (BNO055, VL53L0X, INA226)                            │
│  • IRProximitySensor (4× E18-D80NK)                            │
│  • SharpFrontSensor (GP2Y0A21YK0F)                             │
│  • ImuSafetyEvaluator (tilt/shock detection)                    │
│  • Watchdog (heartbeat monitor)                                │
│  • ModeManager (system state machine)                          │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
                    ┌────────┐
                    │  SAFE  │ ◄──────────────┐
                    │  MODE  │                │
                    └───┬────┘                │
                        │                     │
         ┌──────────────┼──────────────┐     │
         │              │              │     │
         ▼              ▼              ▼     │
   Heartbeat       Web Control    E-Stop    │
   Received?        Active?       Pressed?  │
         │              │              │     │
         Yes            Yes            Yes   │
         │              │              │     │
         ▼              ▼              └─────┤
    ┌────────┐    ┌─────────┐      ┌───────▼─────┐
    │  NAV   │    │ MANUAL  │      │   E-STOP    │
    │  MODE  │    │  MODE   │      │    MODE     │
    └───┬────┘    └────┬────┘      └──────┬──────┘
        │              │                   │
        │              │                   │
        └──────┬───────┘                   │
               │                           │
               ▼                           │
    ┌──────────────────────┐              │
    │   Safety Monitoring  │              │
    │   Loop (every 20ms)  │              │
    └──────────┬───────────┘              │
               │                           │
               ▼                           │
    ┌──────────────────────┐              │
    │  Check IR Sensors    │              │
    │  (rear-L, rear-R,    │              │
    │   left, right)       │              │
    └──────────┬───────────┘              │
               │                           │
         ┌─────┴─────┐                    │
         │ Obstacle  │                    │
         │ detected? │                    │
         └─────┬─────┘                    │
               │                           │
         Yes ──┼── No                     │
         │     │                           │
         │     ▼                           │
         │  ┌──────────────────────┐      │
         │  │ Check Sharp Front    │      │
         │  │ Sensor (10-80cm)     │      │
         │  └──────────┬───────────┘      │
         │             │                   │
         │       ┌─────┴─────┐            │
         │       │ Obstacle  │            │
         │       │ < 20cm?   │            │
         │       └─────┬─────┘            │
         │             │                   │
         │       Yes ──┼── No             │
         │       │     │                   │
         ▼       ▼     ▼                   │
    ┌─────────────────────────┐           │
    │  Trigger ObstacleAvoidance │        │
    │  • startDodge()          │           │
    │  • Calculate dodge vector │          │
    │  • Apply to MecanumDrive  │          │
    └──────────┬──────────────┘           │
               │                           │
               ▼                           │
    ┌──────────────────────┐              │
    │  Check IMU Safety    │              │
    │  (ImuSafetyEvaluator)│              │
    └──────────┬───────────┘              │
               │                           │
         ┌─────┴─────┐                    │
         │ Tilt >    │                    │
         │ WARNING?  │                    │
         │ (15°)     │                    │
         └─────┬─────┘                    │
               │                           │
         Yes ──┼── No                     │
         │     │                           │
         ▼     ▼                           │
    ┌─────────────────────────┐           │
    │  Emit TILT_WARNING      │           │
    │  (log only, no stop)    │           │
    └──────────┬──────────────┘           │
               │                           │
         ┌─────┴─────┐                    │
         │ Tilt >    │                    │
         │ OBSERVE?  │                    │
         │ (25°)     │                    │
         └─────┬─────┘                    │
               │                           │
         Yes ──┼── No                     │
         │     │                           │
         ▼     │                           │
    ┌─────────────────────────┐           │
    │  Emit TILT_OBSERVED     │           │
    │  → Send to Pi (type 134)│           │
    │  → Brain evaluates stop │           │
    └──────────┬──────────────┘           │
               │                           │
         ┌─────┴─────┐                    │
         │ Shock >   │                    │
         │ PEAK?     │                    │
         │ (25 m/s²) │                    │
         └─────┬─────┘                    │
               │                           │
         Yes ──┼── No                     │
         │     │                           │
         ▼     │                           │
    ┌─────────────────────────┐           │
    │  Emit SHOCK_OBSERVED    │           │
    │  → Send to Pi           │           │
    │  → Brain evaluates stop │           │
    └──────────┬──────────────┘           │
               │                           │
               ▼                           │
    ┌──────────────────────┐              │
    │  Check Watchdog      │              │
    │  (Heartbeat timeout?)│              │
    └──────────┬───────────┘              │
               │                           │
         ┌─────┴─────┐                    │
         │ Timeout > │                    │
         │ 2000ms?   │                    │
         └─────┬─────┘                    │
               │                           │
         Yes ──┼── No                     │
         │     │                           │
         ▼     │                           │
    ┌─────────────────────────┐           │
    │  Trigger E-STOP         │───────────┤
    │  • Disable all motors   │           │
    │  • Enter MODE_SAFE      │           │
    │  • Emit type 144 (alive)│           │
    └─────────────────────────┘           │
               │                           │
               ▼                           │
    ┌──────────────────────┐              │
    │  Apply Motor Outputs │              │
    │  (if not E-stopped)  │              │
    │  • Ramp acceleration │              │
    │  • Apply speed limit │              │
    │  • PID control       │              │
    │  • Send PWM to motors│              │
    └──────────────────────┘              │
               │                           │
               │                           │
               └───────────────────────────┘
                  (loop every 20ms)
```

---

## 2. Communication Safety Layer (Watchdog + Heartbeat)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Pi 5 Brain Node Running                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Heartbeat Timer (sends every 50ms via esp32_telemetry_node)   │
│  {"cmd":"heartbeat"}                                            │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
            ┌────────────────────────┐
            │   ESP32 Watchdog       │
            │   (ModeManager)        │
            └────────┬───────────────┘
                     │
              ┌──────┴───────┐
              │ Heartbeat    │
              │ received     │
              │ within 2s?   │
              └──────┬───────┘
                     │
           Yes ──────┼────── No
           │         │
           │         ▼
           │    ┌─────────────────────────┐
           │    │  Heartbeat Timeout      │
           │    │  • MODE_NAV → MODE_SAFE │
           │    │  • Stop all motors      │
           │    │  • Publish type 144     │
           │    │    {"e_stop": true,     │
           │    │     "watchdog_ok": false}│
           │    └─────────────────────────┘
           │              │
           │              └──────────┐
           ▼                         │
    ┌───────────────┐               │
    │  MODE_NAV     │               │
    │  Continue     │               │
    └───────────────┘               │
           │                         │
           │                         ▼
           │              ┌──────────────────┐
           │              │  Pi 5 Detects    │
           │              │  Connection Loss │
           │              │  (via type 144)  │
           │              └────────┬─────────┘
           │                       │
           │                       ▼
           │              ┌──────────────────┐
           │              │  Brain enters    │
           │              │  E_STOP state    │
           │              │  • Cancel Nav2   │
           │              │  • Abort job     │
           │              └──────────────────┘
           │                       │
           └───────────────────────┘
                (reconnect required)
```

---

## 3. LiDAR Safety Layer (Raspberry Pi 5 — ROS 2)

```
┌─────────────────────────────────────────────────────────────────┐
│                    RPLiDAR A1M8-R6                              │
│  /scan topic (LaserScan @ 10 Hz, 360°, 0.15-12m)              │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              brain_node.py Obstacle Processor                   │
│  • Divides scan into 8 zones (F, FL, FR, L, R, Rear, RL, RR)  │
│  • Finds min distance per zone                                 │
│  • Applies hysteresis (obstacle: 1.5m, clear: 1.7m)           │
│  • Debounces transitions (150ms)                               │
└────────────────────────┬────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │ Any zone distance   │
              │ < 1.5m?             │
              └──────────┬──────────┘
                         │
            Yes ─────────┼───────── No
            │            │
            ▼            ▼
┌─────────────────────────┐   ┌───────────────────┐
│  Determine dodge        │   │  Send clear event │
│  direction from zone    │   │  to ESP32         │
│  • Front → rotate       │   │  {"cmd":          │
│  • Left → dodge right   │   │   "obstacle_clear"}│
│  • Right → dodge left   │   └───────────────────┘
│  • FL/FR → compound     │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Send obstacle event to ESP32 via /esp32/cmd                   │
│  {"cmd": "obstacle_left", "distance_m": 0.9, "severity": 0.4} │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              ESP32 ObstacleAvoidance Module                     │
│  • Receives LiDAR event                                        │
│  • Starts dodge maneuver (duration scaled by severity)         │
│  • Overrides current nav command temporarily                   │
│  • Waits for dodge timeout or clear event                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │ Dodge duration      │
              │ expired or clear?   │
              └──────────┬──────────┘
                         │
            Yes ─────────┼───────── No
            │            │
            ▼            ▼
┌─────────────────────┐  ┌──────────────────┐
│  Resume nav command │  │  Continue dodge  │
│  (from Pi)          │  └──────────────────┘
└─────────────────────┘
```

---

## 4. Multi-Layer Priority System

```
┌─────────────────────────────────────────────────────────────────┐
│                    Motion Command Priority                      │
│  (Highest to Lowest — checked every 20ms on ESP32)            │
└─────────────────────────────────────────────────────────────────┘

    Rank 1: E-STOP (Hardware + Software)
            ├─ Manual E-stop button → MODE_E_STOP
            ├─ Watchdog timeout (>2s) → MODE_SAFE
            ├─ Serial cable disconnect → E-STOP
            └─ Brain E_STOP state → {"cmd": "e_stop"}
                    │
                    ▼
            ┌───────────────────┐
            │ ALL MOTORS OFF    │
            │ (BTS7960 disable) │
            │ ONLY "K" or       │
            │ {"cmd":"e_stop_   │
            │  clear"} recovers │
            └───────────────────┘

    Rank 2: IR Proximity Hard-Stop (<20cm)
            ├─ 4× E18-D80NK digital sensors
            ├─ Sharp GP2Y0A21YK0F front sensor
            └─ Immediate brake (no dodge)
                    │
                    ▼
            ┌───────────────────┐
            │ STOP all motors   │
            │ Wait for sensor   │
            │ clear (200ms)     │
            └───────────────────┘

    Rank 3: LiDAR Obstacle Event (1.5m threshold)
            ├─ Pi brain sends obstacle_left/right/front
            ├─ ESP32 ObstacleAvoidance starts dodge
            └─ Duration: 800ms × severity (0.4-1.4×)
                    │
                    ▼
            ┌───────────────────┐
            │ Apply dodge vector│
            │ Override nav cmd  │
            │ Wait for timeout  │
            │ or clear event    │
            └───────────────────┘

    Rank 4: IMU Tilt Warning (>15°)
            ├─ ImuSafetyEvaluator continuous monitoring
            ├─ Warning → log only (no stop)
            └─ Observed (>25°) → send to Pi for evaluation
                    │
                    ▼
            ┌───────────────────┐
            │ Pi brain decides: │
            │ • Continue        │
            │ • Slow down       │
            │ • Emergency stop  │
            └───────────────────┘

    Rank 5: Navigation Command (from Pi brain)
            ├─ {"cmd":"move","vx":N,"vy":N,"omega":N}
            ├─ 50 Hz update rate
            └─ Applied via MecanumDrive kinematics
                    │
                    ▼
            ┌───────────────────┐
            │ Calculate wheel   │
            │ speeds, apply PID,│
            │ send PWM to motors│
            └───────────────────┘

    Rank 6: Manual Web Control (WebSocket)
            ├─ Only active when Pi disconnected
            ├─ MODE_MANUAL
            └─ Direct motor commands via web UI
                    │
                    ▼
            ┌───────────────────┐
            │ Apply to motors   │
            │ (bypass Nav2)     │
            └───────────────────┘
```

---

## 5. Brain State Machine Safety Gates

```
┌─────────────────────────────────────────────────────────────────┐
│                    brain_node.py State Machine                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
                    ┌────────┐
                    │  BOOT  │
                    └───┬────┘
                        │
              ┌─────────┴─────────┐
              │ All sensors ready?│
              │ ESP32 alive?      │
              └─────────┬─────────┘
                        │
                  Yes ──┼── No (wait)
                        │
                        ▼
              ┌──────────────────┐
              │  EXPLORE         │
              │  (SLAM mapping)  │
              └────────┬─────────┘
                       │
                ┌──────┴──────┐
                │ Map complete│
                │ or timeout? │
                └──────┬──────┘
                       │
                  Yes ─┼─ No (continue)
                       │
                       ▼
              ┌──────────────────┐
              │  MAPPING_DONE    │
              │  • Save map      │
              │  • Notify API    │
              └────────┬─────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  IDLE            │
              │  (wait for job)  │
              └────────┬─────────┘
                       │
           ┌───────────┴───────────┐
           │ Job received from API?│
           └───────────┬───────────┘
                       │
                  Yes ─┼─ No (wait)
                       │
                       ▼
     ┌─────────────────────────────────────┐
     │  JOB_NAV_TO_DROPOFF                 │
     │  • Nav2 path planning               │
     │  • Obstacle avoidance active        │
     │  • IMU tilt monitoring              │
     └──────────────┬──────────────────────┘
                    │
     ┌──────────────┴──────────────┐
     │ Safety checks every 100ms:  │
     │ • Nav2 feedback stuck?      │
     │ • IMU tilt > OBSERVE?       │
     │ • Battery < critical (14V)? │
     │ • ESP32 alive heartbeat?    │
     │ • Unload state error?       │
     └──────────────┬──────────────┘
                    │
         Any fail ──┼── All pass
         │          │
         ▼          ▼
┌────────────────┐  ┌─────────────────┐
│  Abort Job     │  │  Reached goal?  │
│  • Cancel Nav2 │  └────────┬────────┘
│  • E-stop ESP32│           │
│  • Notify API  │      Yes ─┼─ No (continue)
│  • Return IDLE │           │
└────────────────┘           ▼
                    ┌──────────────────┐
                    │  JOB_DOCK_UNLOAD │
                    │  • Send begin_dock│
                    │  • Monitor type 140│
                    └────────┬─────────┘
                             │
                  ┌──────────┴──────────┐
                  │ Unload state error? │
                  │ (type 140 error=true)│
                  └──────────┬──────────┘
                             │
                Yes ─────────┼──────── No
                │            │
                ▼            ▼
    ┌────────────────┐  ┌─────────────────┐
    │  Abort Job     │  │  state=7        │
    │  (dock failed) │  │  (complete)?    │
    └────────────────┘  └────────┬────────┘
                                 │
                            Yes ─┼─ No (wait)
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ JOB_RETURN_HOME  │
                        │ • Nav2 to (0,0)  │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  IDLE (job done) │
                        └──────────────────┘
```

---

## 6. Emergency Recovery Procedures

```
┌─────────────────────────────────────────────────────────────────┐
│                    Emergency Scenarios                          │
└─────────────────────────────────────────────────────────────────┘

    Scenario 1: Pi 5 Crash / ROS Node Failure
        ├─ ESP32 Watchdog detects no heartbeat (>2s)
        ├─ ESP32 enters MODE_SAFE
        ├─ All motors stop
        └─ Recovery: restart Pi / ROS nodes via deploy.sh
            │
            └─ ESP32 resumes MODE_NAV when heartbeat returns

    Scenario 2: ESP32 Firmware Crash / USB Disconnect
        ├─ Pi detects no type 144 (alive) for >1s
        ├─ brain_node enters E_STOP state
        ├─ Cancels Nav2, aborts job
        └─ Recovery: power cycle ESP32, wait for reboot
            │
            └─ Pi resumes when type 144 returns

    Scenario 3: Physical Collision (not detected by sensors)
        ├─ ImuSafetyEvaluator detects shock (>25 m/s²)
        ├─ ESP32 sends type 134 with shock_observed=true
        ├─ Pi brain evaluates severity
        └─ Recovery: manual inspection, then clear e-stop

    Scenario 4: Robot Tipped Over (>25° tilt)
        ├─ ImuSafetyEvaluator detects tilt_observed
        ├─ ESP32 sends type 134 with tilt_observed=true
        ├─ Pi brain enters E_STOP
        └─ Recovery: upright robot, clear e-stop, restart

    Scenario 5: Battery Critical (<14V, 0% SOC)
        ├─ INA226Sensor sends type 133 with battery_status="critical"
        ├─ Pi brain enters E_STOP
        ├─ Cancels job, saves map
        └─ Recovery: recharge battery to >18V (>50% SOC)

    Scenario 6: Stuck in Obstacle Loop (dodging back and forth)
        ├─ Brain detects Nav2 no progress for >10s
        ├─ requestRecovery() called
        ├─ AutoRoam replans or brain aborts route
        └─ Recovery: manual teleop out of jam, or abort job

    Scenario 7: Dock Sequence Failure (VL53L0X no cargo)
        ├─ AutoRoam state machine reaches holding phase
        ├─ VL53L0X reads distance > threshold (no cargo present)
        ├─ ESP32 emits type 140 with error=true, error_code=3
        ├─ Pi brain aborts job, frees destination slot
        └─ Recovery: manual cargo placement, retry job
```

---

## 7. Safety Telemetry Dashboard (Real-Time Monitoring)

```
┌─────────────────────────────────────────────────────────────────┐
│            Web UI Safety Monitoring Tab (port 3000)             │
└────────────────────────┬────────────────────────────────────────┘
                         │
         ┌───────────────┴───────────────┐
         │                               │
         ▼                               ▼
┌──────────────────┐          ┌──────────────────┐
│  ESP32 Status    │          │  IMU Safety      │
│  (type 131)      │          │  (type 134)      │
│  • Mode          │          │  • Yaw/Pitch/Roll│
│  • E-stop flag   │          │  • Tilt warning  │
│  • IR sensors    │          │  • Shock event   │
│  • Sharp distance│          │  • Calibration   │
│  • Cylinder state│          └──────────────────┘
└──────────────────┘
         │
         ▼
┌──────────────────┐          ┌──────────────────┐
│  Power Monitor   │          │  Obstacle Status │
│  (type 133)      │          │  (brain_node)    │
│  • Voltage       │          │  • LiDAR zones   │
│  • Current       │          │  • Active dodge  │
│  • SOC %         │          │  • Clear status  │
│  • Battery status│          └──────────────────┘
└──────────────────┘

         │
         ▼
┌──────────────────────────────────────┐
│  Alert Rules (automated)             │
│  • SOC < 20% → yellow warning        │
│  • SOC < 10% → red alert             │
│  • Tilt > 15° → yellow warning       │
│  • Tilt > 25° → red alert, log event │
│  • Watchdog lost → red alert         │
│  • E-stop active → red banner        │
│  • Dock error → notification         │
└──────────────────────────────────────┘
```

---

## 8. Safety Configuration Constants

| Constant | Value | Purpose | File |
|---|---|---|---|
| `HEARTBEAT_TIMEOUT_MS` | 2000 ms | Pi heartbeat timeout → MODE_SAFE | `firmware/include/config.h` |
| `OBSTACLE_THRESHOLD_M` | 1.5 m | LiDAR obstacle distance (Pi) | `services/robot/src/.../brain_node.py` |
| `CLEAR_THRESHOLD_M` | 1.7 m | LiDAR clear hysteresis (Pi) | `services/robot/src/.../brain_node.py` |
| `DODGE_DURATION_MS` | 800 ms | Base dodge maneuver duration | `firmware/include/config.h` |
| `IR_HARD_STOP_CM` | 20 cm | IR sensor emergency stop | `firmware` (E18-D80NK range) |
| `IMU_TILT_WARNING_DEG` | 15° | IMU tilt warning threshold | `firmware/include/config.h` |
| `IMU_TILT_OBSERVE_DEG` | 25° | IMU tilt observed (sent to Pi) | `firmware/include/config.h` |
| `IMU_SHOCK_PEAK_MPS2` | 25 m/s² | Shock detection threshold | `firmware/include/config.h` |
| `BATTERY_CRITICAL_V` | 14.0 V | Battery critical voltage (0% SOC) | `firmware` (INA226Sensor) |
| `MOTION_STUCK_STOP_MS` | 10000 ms | Nav2 stuck timeout → abort | `services/robot` (brain_node) |

---

## Safety Compliance Checklist

- [x] Hardware E-stop button (manual)
- [x] Watchdog timeout → automatic brake
- [x] IR proximity sensors (4×) for close-range
- [x] Sharp distance sensor (front)
- [x] LiDAR obstacle avoidance (360°)
- [x] IMU tilt detection (2 thresholds)
- [x] IMU shock detection
- [x] Battery voltage monitoring + SOC calculation
- [x] Serial link liveness detection (type 144)
- [x] Multi-layer priority system (hardware > software)
- [x] Real-time telemetry (20 Hz IMU, 2 Hz status)
- [x] Recovery procedures documented
- [x] Fail-safe defaults (motors off on boot)
- [x] No persistent state across power cycles

---

## Contact

For safety-related questions or incident reports:
- Hardware: `firmware/CLAUDE.md`
- ROS 2: `services/robot/CLAUDE.md`
- System: Root `CLAUDE.md`

**Last Updated:** 2026-09-19
