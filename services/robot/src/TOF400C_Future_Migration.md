# TOF400C Future Consumer Migration

This release keeps the existing Sharp-compatible protocol aliases while the ESP32 front sensor changes to TOF400C/VL53L1X. The following work is intentionally deferred and must be completed before removing the aliases.

## Web

- Prefer canonical type-136 fields: `source: "front_tof"`, `sensor: "vl53l1x"`, `distance_mm`, `distance_cm`, `valid`, `stale`, `present`, `too_close`, and `slowing`.
- Add explicit `front_tof` state to `RobotTelemetryProvider` and use it in sensor/map panels.
- Keep `st.sharp` and legacy type-136 parsing as a fallback until all deployed firmware is migrated.
- Replace the visible Sharp label with the Vietnamese front-ToF label only after canonical data is confirmed in production.

## Mobile

- Update type-136 parsing and obstacle state to use `front_tof` validity/freshness fields.
- Keep legacy `sharp` parsing during the mixed-firmware period.
- Ensure absent, invalid, timed-out, or stale front-ToF data is rendered as unavailable/obstructed rather than clear.

## Deploy and operations

- No CI/CD workflow or deploy script changes are included in this release.
- Before rollout, document the physical wiring: GPIO43 -> rear VL53L0X XSHUT and GPIO44 -> front VL53L1X XSHUT; both sensors require boot-time address assignment.
- Add a deployment gate that verifies firmware and Pi bridge versions are compatible, then checks `/esp32/sharp`, `/esp32/front_tof`, and the four I2C addresses after reboot.
- Keep rollback support until the Web/Mobile consumers accept canonical front-ToF fields and the legacy aliases can be removed safely.
- Do not run unattended floor tests until supervised braking-distance and sensor-failure checks pass.
