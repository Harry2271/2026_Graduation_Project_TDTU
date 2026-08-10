"""ESP32 telemetry panel."""
from __future__ import annotations
import json
from typing import Any
from PySide6.QtWidgets import QWidget, QVBoxLayout, QPlainTextEdit


class Esp32Panel(QWidget):
    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        layout = QVBoxLayout(self)
        self.text = QPlainTextEdit()
        self.text.setReadOnly(True)
        layout.addWidget(self.text)

    def refresh(self) -> None:
        s = self.state.esp32_status
        enc = self.state.esp32_encoder or []
        if not s and not enc:
            self.text.setPlainText('(chờ ESP32 telemetry…)')
            return
        lines: list[str] = []
        if s:
            ts = s.get('ts', 0)
            motors = s.get('motors', []) or []
            nav = s.get('nav', []) or []
            ir = s.get('ir', []) or []
            st = s.get('st', {}) or {}
            lines.extend([
                '=== ESP32 STATUS / TYPE 131 ===',
                f'uptime_ms     : {ts}',
                f'mode          : {s.get("mode", "?")}',
                f'e_stop        : {s.get("estop", False)}',
                f'max_speed_pct : {s.get("max_pct", "?")}',
                f'nav vx/vy/w   : {nav}',
                f'ir sensors    : {ir}', '',
                '--- sensors ---',
                f'imu_ok        : {st.get("imu", "—")}',
                f'power_ok      : {st.get("pwr", "—")}',
                f'sharp_cm      : {st.get("sharp", "—")}',
                f'obstacle      : {st.get("obs", "—")}',
                f'tof_mm        : {st.get("tof_mm", "—")}',
                f'cylinder      : {st.get("cyl", "—")}',
                f'cargo         : {st.get("cargo", "—")}', '',
                '--- motors (target / rpm / encoder) ---',
            ])
            for i, motor in enumerate(motors):
                lines.append(f'{i}: target={motor.get("t", "?")}  '
                             f'rpm={motor.get("r", "?")}  '
                             f'count={motor.get("c", "?")}  dir={motor.get("d", "?")}')
        if enc:
            lines.extend(['', '=== ENCODER / TYPE 130 ==='])
            lines.append(json.dumps(enc, ensure_ascii=False, indent=2))
        self.text.setPlainText('\n'.join(lines))
