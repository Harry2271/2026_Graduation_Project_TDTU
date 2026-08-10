"""Left-side control: mode buttons + trip frame + status row."""
from __future__ import annotations
from typing import Any
from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QFrame, QSizePolicy,
)

class ControlPanel(QWidget):
    """Mode switch, home display, trip timer, and status labels."""
    mode_changed = Signal(str)
    e_stop_requested = Signal()

    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)
        # Mode buttons
        mode_row = QHBoxLayout()
        self.btn_manual = QPushButton('MANUAL')
        self.btn_auto = QPushButton('AUTO')
        for btn in (self.btn_manual, self.btn_auto):
            btn.setMinimumHeight(34)
            btn.setCheckable(True)
            mode_row.addWidget(btn)
        self.btn_manual.clicked.connect(lambda: self.mode_changed.emit('MANUAL'))
        self.btn_auto.clicked.connect(lambda: self.mode_changed.emit('AUTO'))
        layout.addLayout(mode_row)
        # Status labels
        self.lbl_status = QLabel('mode: idle   |   ctrl: MANUAL')
        self.lbl_status.setObjectName('hint')
        self.lbl_connection = QLabel('● disconnected')
        self.lbl_connection.setObjectName('status-error')
        layout.addWidget(self.lbl_status)
        layout.addWidget(self.lbl_connection)
        # E-STOP button
        self.btn_estop = QPushButton('⚠ E-STOP (Esc)')
        self.btn_estop.setObjectName('accent-red')
        self.btn_estop.setMinimumHeight(36)
        self.btn_estop.clicked.connect(self.e_stop_requested.emit)
        layout.addWidget(self.btn_estop)

    def refresh(self) -> None:
        m = self.state.mode or 'idle'
        c = self.state.control_mode
        self.lbl_status.setText(f'mode: {m}   |   ctrl: {c}')
        if self.state.connected:
            self.lbl_connection.setText('● connected')
            self.lbl_connection.setObjectName('status-ok')
        else:
            self.lbl_connection.setText('● disconnected')
            self.lbl_connection.setObjectName('status-error')
        self.lbl_connection.style().polish(self.lbl_connection)
        self.btn_manual.setChecked(self.state.control_mode == 'MANUAL')
        self.btn_auto.setChecked(self.state.control_mode == 'AUTO')
