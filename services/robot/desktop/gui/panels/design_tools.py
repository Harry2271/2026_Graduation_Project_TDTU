"""Design tools panel: waypoint list, wall list, sequence builder."""
from __future__ import annotations
from typing import Any
from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QListWidget,
    QListWidgetItem, QGroupBox,
)

from ..state import (
    load_json, save_json, _WAYPOINTS_PATH, _SEQUENCE_PATH, _MAP_PATH,
)


class WaypointPanel(QWidget):
    goto_requested = Signal(int)
    delete_requested = Signal(int)
    rename_requested = Signal(int)
    set_apriltag = Signal(int)

    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        self._cached_key: tuple | None = None
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel('Danh sách waypoint / kho'))
        self.list = QListWidget()
        self.list.itemSelectionChanged.connect(self._on_select)
        layout.addWidget(self.list)
        row = QHBoxLayout()
        for label, signal in [
            ('▶ Đi tới', self.goto_requested),
            ('✎ Đổi tên', self.rename_requested),
            ('# Tag', self.set_apriltag),
            ('🗑 Xóa', self.delete_requested),
        ]:
            b = QPushButton(label)
            b.clicked.connect(self._on_click(signal))
            row.addWidget(b)
        layout.addLayout(row)
        self._hint = QLabel('Chọn 1 dòng rồi bấm nút để thực hiện')
        self._hint.setStyleSheet('color:#8b949e;')
        layout.addWidget(self._hint)

    def _on_select(self) -> None:
        sel = self.list.currentRow()
        if sel >= 0 and sel < len(self.state.waypoints):
            wp = self.state.waypoints[sel]
            wp_id = int(wp.get('id', -1))
            kind = wp.get('kind', 'waypoint')
            kind_str = 'kho' if kind == 'warehouse' else 'wp'
            self._hint.setText(
                f'Đã chọn {kind_str} #{wp_id} — nhấn Delete để xóa'
                if self.state.canvas_mode == 'waypoint' and kind == 'warehouse'
                else f'Đã chọn {kind_str} #{wp_id}')
            # Mirror selection into shared state so global shortcuts can read it.
            self.state.selected_waypoint_id = wp_id
        else:
            self._hint.setText('Chọn 1 dòng rồi bấm nút để thực hiện')
            self.state.selected_waypoint_id = -1

    def _on_click(self, signal: Signal):
        def emit_signal():
            row = self.list.currentRow()
            if row < 0:
                return
            item = self.list.item(row)
            if item is None:
                return
            wid = int(item.data(Qt.ItemDataRole.UserRole))
            signal.emit(wid)
        return emit_signal

    def _snapshot_key(self) -> tuple:
        return tuple((wp.get('id'), wp.get('label'), wp.get('kind'),
                      wp.get('tag_id'), wp.get('x'), wp.get('y'))
                     for wp in self.state.waypoints)

    def refresh(self) -> None:
        # Skip the expensive rebuild when nothing relevant changed —
        # this preserves the user's selection between ticks.
        key = self._snapshot_key()
        if key == self._cached_key:
            return
        self._cached_key = key
        prev_row = self.list.currentRow()
        self.list.blockSignals(True)
        self.list.clear()
        for wp in self.state.waypoints:
            kind = wp.get('kind', 'waypoint')
            tag = wp.get('tag_id')
            tag_str = f'  TAG#{tag}' if tag is not None else ''
            kind_icon = '📦' if kind == 'warehouse' else '📍'
            txt = (f"{kind_icon} #{wp.get('id', '?')}  "
                   f"{wp.get('label', '?')}{tag_str}  "
                   f"({float(wp['x']):.2f}, {float(wp['y']):.2f})")
            item = QListWidgetItem(txt)
            item.setData(Qt.ItemDataRole.UserRole, int(wp.get('id', -1)))
            self.list.addItem(item)
        self.list.blockSignals(False)
        if 0 <= prev_row < self.list.count():
            self.list.setCurrentRow(prev_row)


class WallPanel(QWidget):
    delete_wall = Signal(int)
    apply_geofence = Signal()
    edit_wall = Signal(int)

    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        self._cached_key: tuple | None = None
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel('Danh sách tường (line)'))
        self.list = QListWidget()
        self.list.itemSelectionChanged.connect(self._on_select)
        self.list.itemDoubleClicked.connect(self._on_double_click)
        layout.addWidget(self.list)
        row = QHBoxLayout()
        btn_edit = QPushButton('✎ Sửa')
        btn_edit.clicked.connect(self._on_edit)
        btn_del = QPushButton('🗑 Xóa')
        btn_del.clicked.connect(self._on_delete)
        btn_apply = QPushButton('Áp dụng geofence')
        btn_apply.clicked.connect(self.apply_geofence.emit)
        row.addWidget(btn_edit)
        row.addWidget(btn_del)
        row.addWidget(btn_apply)
        layout.addLayout(row)
        self._hint = QLabel('Chọn 1 line rồi bấm Sửa / Xóa')
        self._hint.setStyleSheet('color:#8b949e;')
        layout.addWidget(self._hint)

    def _on_select(self) -> None:
        sel = self.list.currentRow()
        if sel >= 0:
            self._hint.setText(f'Đã chọn line #{sel}')

    def _on_double_click(self, item: QListWidgetItem) -> None:
        idx = self.list.row(item)
        if 0 <= idx < len(self.state.map_lines):
            self.edit_wall.emit(idx)

    def _on_delete(self) -> None:
        idx = self.list.currentRow()
        if idx >= 0:
            self.delete_wall.emit(idx)

    def _on_edit(self) -> None:
        idx = self.list.currentRow()
        if 0 <= idx < len(self.state.map_lines):
            self.edit_wall.emit(idx)
        else:
            self._hint.setText('Chọn 1 line trước khi bấm Sửa')

    def _snapshot_key(self) -> tuple:
        return tuple(tuple(line) for line in self.state.map_lines)

    def refresh(self) -> None:
        # Preserve selection across ticks by only rebuilding when the
        # underlying line list changes.
        key = self._snapshot_key()
        if key == self._cached_key:
            return
        self._cached_key = key
        prev_row = self.list.currentRow()
        self.list.blockSignals(True)
        self.list.clear()
        import math
        for idx, line in enumerate(self.state.map_lines):
            length = math.hypot(float(line[2]) - float(line[0]),
                                float(line[3]) - float(line[1]))
            self.list.addItem(f"#{idx}  dài: {length:.2f}m")
        self.list.blockSignals(False)
        if 0 <= prev_row < self.list.count():
            self.list.setCurrentRow(prev_row)


class SequencePanel(QWidget):
    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel('Kịch bản tự động'))
        self.list = QListWidget()
        layout.addWidget(self.list)
        self.btn_add_wp = QPushButton('+ Waypoint')
        self.btn_add_home = QPushButton('+ Home')
        self.btn_extend = QPushButton('+ Nâng xi-lanh')
        self.btn_retract = QPushButton('+ Hạ xi-lanh')
        for btn in (self.btn_add_wp, self.btn_add_home,
                    self.btn_extend, self.btn_retract):
            btn.clicked.connect(self._save)
            layout.addWidget(btn)

    def _save(self) -> None:
        save_json(_SEQUENCE_PATH, self.state.sequence)
        self.refresh()

    def refresh(self) -> None:
        self.list.clear()
        for step in self.state.sequence:
            kind = step.get('type', '?')
            if kind == 'waypoint':
                desc = f"→ waypoint #{step.get('waypoint_id', '?')}"
            elif kind == 'home':
                desc = '→ Về home'
            elif kind == 'cylinder':
                desc = f"xi-lanh {step.get('action', '?')}"
            else:
                desc = str(step)
            self.list.addItem(desc)
