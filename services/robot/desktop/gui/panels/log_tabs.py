"""Log / trip / help tabs."""
from __future__ import annotations
import time
from typing import Any
from PySide6.QtWidgets import QWidget, QVBoxLayout, QPlainTextEdit, QTextBrowser


class LogPanel(QWidget):
    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        layout = QVBoxLayout(self)
        self.text = QPlainTextEdit()
        self.text.setReadOnly(True)
        layout.addWidget(self.text)

    def refresh(self) -> None:
        lines = [f'{time.strftime("%H:%M:%S", time.localtime(t))}  {m}'
                 for t, m in self.state.ack_log]
        self.text.setPlainText('\n'.join(lines) or '(trống)')


class TripPanel(QWidget):
    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        layout = QVBoxLayout(self)
        self.text = QPlainTextEdit()
        self.text.setReadOnly(True)
        layout.addWidget(self.text)

    def refresh(self) -> None:
        if not self.state.trip_log:
            self.text.setPlainText('(chưa có chuyến đi)')
            return
        lines = []
        for entry in self.state.trip_log[-25:]:
            start = time.strftime('%H:%M:%S', time.localtime(entry.get('start_ts', 0)))
            dur = entry.get('duration_s', 0)
            goal = entry.get('goal', {}) or {}
            label = goal.get('label', '?')
            x = float(goal.get('x', 0))
            y = float(goal.get('y', 0))
            status = entry.get('status', '?')
            lines.append(f'{start}  {status}  {dur:.1f}s  → {label} ({x:+.2f},{y:+.2f})')
        self.text.setPlainText('\n'.join(lines))


class HelpPanel(QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        body = QTextBrowser()
        body.setHtml('''
<h3>PHÍM TẮT — Phân loại</h3>

<h4 style="color:#ff9e64">Xem / Chuyển chế độ hiển thị</h4>
<table border="1" cellpadding="5" cellspacing="0" style="color:#c9d1d9">
<tr><th>Phím</th><th>Chức năng</th></tr>
<tr><td>F1</td><td>Robot view — xem robot, LiDAR, ESP32 real-time</td></tr>
<tr><td>F2</td><td>Thiết kế bản đồ — vẽ tường, geofence</td></tr>
<tr><td>F3</td><td>Cấu hình kho — đặt waypoint, gán AprilTag</td></tr>
</table>

<h4 style="color:#ff9e64">Điều khiển robot (MANUAL)</h4>
<table border="1" cellpadding="5" cellspacing="0" style="color:#c9d1d9">
<tr><th>Phím</th><th>Chức năng</th></tr>
<tr><td>W / ↑</td><td>Tiến</td></tr>
<tr><td>S / ↓</td><td>Lùi</td></tr>
<tr><td>A / ←</td><td>Trượt trái</td></tr>
<tr><td>D / →</td><td>Trượt phải</td></tr>
<tr><td>Q</td><td>Xoay trái</td></tr>
<tr><td>E</td><td>Xoay phải</td></tr>
</table>

<h4 style="color:#ff9e64">Xi-lanh (MANUAL)</h4>
<table border="1" cellpadding="5" cellspacing="0" style="color:#c9d1d9">
<tr><th>Phím</th><th>Chức năng</th></tr>
<tr><td>Space</td><td>Mở xi-lanh (extend)</td></tr>
<tr><td>R</td><td>Thu xi-lanh (retract)</td></tr>
<tr><td>X</td><td>Dừng xi-lanh (stop)</td></tr>
</table>

<h4 style="color:#ff9e64">Hệ thống</h4>
<table border="1" cellpadding="5" cellspacing="0" style="color:#c9d1d9">
<tr><th>Phím</th><th>Chức năng</th></tr>
<tr><td>M</td><td>Chuyển đổi MANUAL ↔ AUTO</td></tr>
<tr><td>Esc</td><td>E-STOP — dừng khẩn cấp</td></tr>
</table>

<h3 style="color:#58a6ff">Chế độ hiển thị (canvas)</h3>
<table border="1" cellpadding="5" cellspacing="0" style="color:#c9d1d9">
<tr><th>Chế độ</th><th>Thao tác trên canvas</th></tr>
<tr><td>Robot view</td><td>Xem robot di chuyển real-time. Cột phải hiện telemetry.</td></tr>
<tr><td>Thiết kế bản đồ</td><td>Click = vẽ tường. Double-click = sửa. Click đầu mút = kéo chỉnh. Chuột phải = xóa.</td></tr>
<tr><td>Cấu hình kho</td><td>Click = đặt điểm. Click vào điểm có sẵn = kéo di chuyển.</td></tr>
</table>
<p style="color:#8b949e">Cuộn chuột = zoom. Giữ giữa chuột = kéo bản đồ.</p>

<h3 style="color:#3fb950">Quy trình khảo sát kho tự động</h3>
<ol style="color:#c9d1d9">
  <li>Vẽ tường bản đồ → nhấn <b>Lưu bản đồ</b></li>
  <li>Bấm <b>Đặt Home</b> trên thanh dưới canvas</li>
  <li>Chuyển sang <b>F3 Cấu hình kho</b> → đặt vị trí từng kho</li>
  <li>Chuyển sang <b>F2</b> → chọn <b>📦 Kho + AprilTag</b> để gán TAG</li>
  <li>Bấm <b>M</b> chuyển sang AUTO</li>
  <li>Nhấn <b>TỰ KHẢO SÁT</b> trên thanh trên cùng</li>
</ol>
''')
        layout.addWidget(body)
