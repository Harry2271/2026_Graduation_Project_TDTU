"""QSS dark theme for the AGV Operator PySide6 app."""

DARK_THEME = r"""
/* ── Global ──────────────────────────────────────────────────── */
QMainWindow, QWidget {
    background: #0d1117;
    color: #c9d1d9;
    font-family: "Segoe UI", "Noto Sans", sans-serif;
    font-size: 13px;
}
QSplitter::handle { background: #21262d; width: 3px; }
QSplitter::handle:hover { background: #1f6feb; }

/* ── Menus ───────────────────────────────────────────────────── */
QMenuBar { background: #161b22; color: #c9d1d9; border-bottom: 1px solid #30363d; }
QMenuBar::item:selected { background: #1f6feb; }
QMenu { background: #161b22; color: #c9d1d9; border: 1px solid #30363d; }
QMenu::item:selected { background: #1f6feb; }
QMenu::separator { height: 1px; background: #30363d; }

/* ── Buttons ─────────────────────────────────────────────────── */
QPushButton {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 6px 14px;
    font-weight: 500;
}
QPushButton:hover { background: #30363d; border-color: #1f6feb; }
QPushButton:pressed { background: #1f6feb; color: #ffffff; }
QPushButton:disabled { color: #484f58; background: #161b22; border-color: #21262d; }
QPushButton:checked { background: #1f6feb; color: #ffffff; border-color: #1f6feb; }

/* Accent buttons */
QPushButton#accent-green { background: #238636; color: #ffffff; }
QPushButton#accent-green:hover { background: #2ea043; }
QPushButton#accent-red { background: #da3633; color: #ffffff; }
QPushButton#accent-red:hover { background: #f85149; }
QPushButton#accent-orange { background: #9e6a03; color: #ffffff; }
QPushButton#accent-orange:hover { background: #bb8009; }
QPushButton#accent-blue { background: #1f6feb; color: #ffffff; }
QPushButton#accent-blue:hover { background: #388bfd; }

/* ── Labels ──────────────────────────────────────────────────── */
QLabel { color: #c9d1d9; }
QLabel#heading { color: #58a6ff; font-size: 14px; font-weight: bold; }
QLabel#hint { color: #8b949e; font-size: 11px; }
QLabel#status-ok { color: #3fb950; }
QLabel#status-warn { color: #d29922; }
QLabel#status-error { color: #f85149; }

/* ── Text edits / Log panels ─────────────────────────────────── */
QTextEdit, QPlainTextEdit {
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 4px;
    font-family: "Cascadia Mono", "Consolas", monospace;
    font-size: 12px;
    selection-background-color: #1f6feb;
}

/* ── List / Tree views ───────────────────────────────────────── */
QListWidget, QTreeWidget, QTableWidget {
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 4px;
    alternate-background-color: #161b22;
}
QListWidget::item:selected, QTreeWidget::item:selected, QTableWidget::item:selected {
    background: #1f6feb;
    color: #ffffff;
}

/* ── Tab widget ──────────────────────────────────────────────── */
QTabWidget::pane { border: 1px solid #30363d; background: #0d1117; }
QTabBar::tab {
    background: #161b22;
    color: #8b949e;
    border: 1px solid #30363d;
    border-bottom: none;
    padding: 6px 14px;
    border-top-left-radius: 4px;
    border-top-right-radius: 4px;
}
QTabBar::tab:selected { background: #0d1117; color: #58a6ff; }
QTabBar::tab:hover { color: #c9d1d9; }

/* ── Scroll bars ─────────────────────────────────────────────── */
QScrollBar:vertical { background: #0d1117; width: 10px; border: none; }
QScrollBar::handle:vertical { background: #30363d; border-radius: 5px; min-height: 30px; }
QScrollBar::handle:vertical:hover { background: #484f58; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0px; }
QScrollBar:horizontal { background: #0d1117; height: 10px; border: none; }
QScrollBar::handle:horizontal { background: #30363d; border-radius: 5px; min-width: 30px; }
QScrollBar::handle:horizontal:hover { background: #484f58; }
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0px; }

/* ── Line edits / spin boxes ─────────────────────────────────── */
QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox {
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 4px 8px;
}
QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus {
    border-color: #1f6feb;
}
QComboBox::drop-down { border: none; }
QComboBox QAbstractItemView {
    background: #161b22;
    color: #c9d1d9;
    selection-background-color: #1f6feb;
    border: 1px solid #30363d;
}

/* ── Graphics view (canvas) ──────────────────────────────────── */
QGraphicsView {
    background: #06101c;
    border: none;
}

/* ── Labels frame borders ────────────────────────────────────── */
QGroupBox {
    border: 1px solid #30363d;
    border-radius: 4px;
    margin-top: 12px;
    padding-top: 14px;
    font-weight: bold;
    color: #58a6ff;
}
QGroupBox::title {
    subcontrol-origin: margin;
    left: 12px;
    padding: 0 4px;
}

/* ── Tooltips ────────────────────────────────────────────────── */
QToolTip {
    background: #1c2128;
    color: #c9d1d9;
    border: 1px solid #30363d;
    padding: 4px;
}
"""
