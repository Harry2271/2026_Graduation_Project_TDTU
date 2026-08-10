"""Auto-survey panel + warehouse state display."""
from __future__ import annotations
from typing import Any
from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
)


class SurveyPanel(QWidget):
    survey_begin = Signal()
    survey_stop = Signal()
    survey_reset = Signal()

    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)

        row1 = QHBoxLayout()
        self.btn_start = QPushButton('TỰ KHẢO SÁT (bỏ trống kho)')
        self.btn_start.setObjectName('accent-green')
        self.btn_start.setMinimumHeight(36)
        self.btn_start.clicked.connect(self.survey_begin.emit)
        row1.addWidget(self.btn_start)
        layout.addLayout(row1)

        row2 = QHBoxLayout()
        self.btn_stop = QPushButton('DỪNG KHẢO SÁT')
        self.btn_stop.setObjectName('accent-orange')
        self.btn_stop.clicked.connect(self.survey_stop.emit)
        row2.addWidget(self.btn_stop)
        self.btn_reset = QPushButton('Reset kho đã đổ')
        self.btn_reset.clicked.connect(self.survey_reset.emit)
        row2.addWidget(self.btn_reset)
        layout.addLayout(row2)

        self.lbl_hint = QLabel('')
        self.lbl_hint.setObjectName('hint')
        layout.addWidget(self.lbl_hint)
        layout.addStretch(1)

    def refresh(self) -> None:
        ws = self.state.warehouse_state
        n_done = len(ws.get('done_ids', []))
        wp_all = [w for w in self.state.waypoints
                  if isinstance(w, dict) and 'x' in w and 'y' in w]
        n_total = len(wp_all)
        if self.state.survey_running:
            q = len(self.state.survey_queue)
            self.lbl_hint.setText(f'🔄 đang chạy: còn {q} kho chưa đổ')
            self.lbl_hint.setStyleSheet('color: #58a6ff;')
        elif self.state.survey_paused:
            self.lbl_hint.setText(f'⏸ đã tạm dừng ({n_done}/{n_total} đã đổ)')
            self.lbl_hint.setStyleSheet('color: #d29922;')
        elif n_done == 0:
            self.lbl_hint.setText(f'{n_total} kho chờ khảo sát')
            self.lbl_hint.setStyleSheet('color: #8b949e;')
        else:
            self.lbl_hint.setText(f'{n_done}/{n_total} kho đã đổ')
            self.lbl_hint.setStyleSheet('color: #3fb950;')

        self.btn_start.setEnabled(not self.state.survey_running)
        self.btn_reset.setEnabled(not self.state.survey_running)
