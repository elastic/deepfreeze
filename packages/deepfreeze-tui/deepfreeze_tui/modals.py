"""Modal screens for deepfreeze TUI."""

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static


# -- Binding definitions by context --

GLOBAL_BINDINGS = [
    ("tab", "Switch panel"),
    ("1-5", "Jump to panel"),
    ("ctrl+r", "Refresh data"),
    ("?", "Open keybindings menu"),
    ("q", "Quit"),
]

REPOS_BINDINGS = [
    ("r", "Rotate"),
    ("t", "Thaw"),
    ("c", "Cleanup"),
    ("f", "Fix (repair metadata)"),
]

THAW_BINDINGS = [
    ("f", "Refreeze"),
]

BUCKET_BINDINGS: list[tuple[str, str]] = []

ILM_BINDINGS: list[tuple[str, str]] = []

NAV_BINDINGS = [
    ("j / down", "Move cursor down"),
    ("k / up", "Move cursor up"),
    ("enter", "Select item"),
    ("esc", "Cancel / close"),
]

# Map panel IDs to their context bindings
PANEL_BINDINGS = {
    "repos": ("Repositories", REPOS_BINDINGS),
    "thaw-requests": ("Thaw Requests", THAW_BINDINGS),
    "buckets": ("Buckets", BUCKET_BINDINGS),
    "ilm-policies": ("ILM Policies", ILM_BINDINGS),
    "detail-scroll": ("Detail", []),
}


class HelpModal(ModalScreen[None]):
    """Centered help modal showing context-sensitive keybindings."""

    BINDINGS = [
        Binding("escape", "dismiss", "Close", show=False),
        Binding("question_mark", "dismiss", "Close", show=False),
    ]

    DEFAULT_CSS = """
    HelpModal {
        align: center middle;
    }

    #help-overlay {
        width: 100%;
        height: 100%;
        align: center middle;
    }

    #help-container {
        width: 60;
        max-height: 80%;
        border: solid #008a5e;
        border-title-color: #008a5e;
        border-title-style: bold;
        border-title-align: center;
        background: #1a1c21;
        padding: 0 1;
    }

    .help-section-header {
        width: 100%;
        text-align: center;
        color: #7b7b7b;
        text-style: bold;
        margin-top: 1;
    }

    .help-line {
        width: 100%;
        height: 1;
    }

    .help-footer {
        width: 100%;
        text-align: center;
        color: #7b7b7b;
        text-style: italic;
        margin-top: 1;
        padding-bottom: 1;
    }
    """

    def __init__(self, focused_panel_id: str = "") -> None:
        super().__init__()
        self.focused_panel_id = focused_panel_id

    def compose(self) -> ComposeResult:
        with VerticalScroll(id="help-container") as container:
            container.border_title = "Keybindings"

            # Panel-specific bindings
            panel_name, panel_binds = PANEL_BINDINGS.get(
                self.focused_panel_id, ("", [])
            )
            if panel_binds:
                yield Static(f"--- {panel_name} ---", classes="help-section-header")
                for key, desc in panel_binds:
                    yield Static(
                        f"[bold #008a5e]{key:>14}[/bold #008a5e] {desc}",
                        classes="help-line",
                    )

            # Navigation
            yield Static("--- Navigation ---", classes="help-section-header")
            for key, desc in NAV_BINDINGS:
                yield Static(
                    f"[bold #008a5e]{key:>14}[/bold #008a5e] {desc}",
                    classes="help-line",
                )

            # Global
            yield Static("--- Global ---", classes="help-section-header")
            for key, desc in GLOBAL_BINDINGS:
                yield Static(
                    f"[bold #008a5e]{key:>14}[/bold #008a5e] {desc}",
                    classes="help-line",
                )

            yield Static("Close: <esc> or <?>", classes="help-footer")

    def on_click(self) -> None:
        """Close on background click."""
        self.dismiss()
