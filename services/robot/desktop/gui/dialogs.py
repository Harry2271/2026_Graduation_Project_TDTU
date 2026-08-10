"""QDialog subclasses for connect, wall editor, geofence editor."""
from __future__ import annotations

import math
from typing import Any
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QLineEdit,
    QDoubleSpinBox, QFormLayout, QDialogButtonBox, QPlainTextEdit, QMessageBox,
)


class ConnectDialog(QDialog):
    """Manual WebSocket URL entry."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle('Kết nối thủ công')
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel('Nhập IP hoặc URL của Pi 5:'))
        self.url_edit = QLineEdit('ws://')
        layout.addWidget(self.url_edit)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok |
                                   QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def get_url(self) -> str:
        url = self.url_edit.text().strip()
        if not url.startswith('ws://') and not url.startswith('wss://'):
            url = f'ws://{url}:9091'
        return url


class WallEditorDialog(QDialog):
    """Edit length, angle, centre position of a wall line."""

    def __init__(self, line: list[float], parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle('Sửa đường tường')
        self._line = line
        x1, y1, x2, y2 = line[:4]
        length = math.hypot(x2 - x1, y2 - y1)
        angle = math.degrees(math.atan2(y2 - y1, x2 - x1))
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2

        form = QFormLayout()
        # Chiều dài + góc xoay + tâm là 3 cách hiệu quả để định vị line.
        self.spin_length = QDoubleSpinBox(); self.spin_length.setRange(0.05, 50.0)
        self.spin_length.setValue(length); self.spin_length.setSuffix(' m')
        self.spin_length.setDecimals(2)
        self.spin_angle = QDoubleSpinBox(); self.spin_angle.setRange(-360.0, 360.0)
        self.spin_angle.setValue(angle); self.spin_angle.setSuffix(' °')
        self.spin_angle.setDecimals(1)
        self.spin_cx = QDoubleSpinBox(); self.spin_cx.setRange(-100, 100); self.spin_cx.setDecimals(3)
        self.spin_cx.setValue(cx)
        self.spin_cy = QDoubleSpinBox(); self.spin_cy.setRange(-100, 100); self.spin_cy.setDecimals(3)
        self.spin_cy.setValue(cy)
        # Endpoints (chỉ đọc — chỉnh bằng kéo thả trên canvas)
        self.lbl_x1 = QLabel(f'{x1:.3f}')
        self.lbl_y1 = QLabel(f'{y1:.3f}')
        self.lbl_x2 = QLabel(f'{x2:.3f}')
        self.lbl_y2 = QLabel(f'{y2:.3f}')
        form.addRow('Chiều dài:', self.spin_length)
        form.addRow('Góc xoay:', self.spin_angle)
        form.addRow('Tâm X (m):', self.spin_cx)
        form.addRow('Tâm Y (m):', self.spin_cy)
        form.addRow('─' * 24, QLabel(''))
        form.addRow('Đầu A  X =', self.lbl_x1)
        form.addRow('Đầu A  Y =', self.lbl_y1)
        form.addRow('Đầu B  X =', self.lbl_x2)
        form.addRow('Đầu B  Y =', self.lbl_y2)
        layout = QVBoxLayout(self)
        layout.addLayout(form)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save |
                                   QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def result_line(self) -> list[float]:
        length = float(self.spin_length.value())
        angle = math.radians(float(self.spin_angle.value()))
        cx = float(self.spin_cx.value())
        cy = float(self.spin_cy.value())
        dx = math.cos(angle) * length / 2
        dy = math.sin(angle) * length / 2
        return [cx - dx, cy - dy, cx + dx, cy + dy, self._line[4] if len(self._line) > 4 else 0.10]


class GeofenceEditorDialog(QDialog):
    """Edit geofence polygon + margins."""

    def __init__(self, cfg: dict, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle('Sửa vùng geofence')
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel('Polygon (mỗi dòng: x,y đơn vị mét):'))
        self.text = QPlainTextEdit()
        for p in cfg.get('polygon', []):
            self.text.appendPlainText(f'{p[0]},{p[1]}')
        layout.addWidget(self.text)
        self.chk_enabled = QLabel('Đã bật geofence (sửa trong JSON)' )
        layout.addWidget(self.chk_enabled)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok |
                                   QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def result_polygon(self) -> list[list[float]] | None:
        out: list[list[float]] = []
        for line in self.text.toPlainText().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                x, y = [float(p.strip()) for p in line.split(',')]
                out.append([x, y])
            except ValueError:
                QMessageBox.warning(self, 'Sai định dạng', f'Bỏ qua dòng: {line!r}')
        return out if len(out) >= 3 else None
