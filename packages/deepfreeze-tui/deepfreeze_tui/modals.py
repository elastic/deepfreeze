"""Help overlay widget for deepfreeze TUI.

Uses an absolutely-positioned widget within the same screen so
the panels underneath remain rendered. No ModalScreen or separate
screen is involved.
"""

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.widgets import OptionList, Static
from textual.widgets.option_list import Option

try:
    from textual.widgets.option_list import Separator
except ImportError:
    Separator = None  # type: ignore[assignment, misc]


# -- Binding definitions by context --

GLOBAL_BINDINGS = [
    ("tab", "Switch panel", None),
    ("1-5", "Jump to panel", None),
    ("ctrl+r", "Refresh data", "refresh"),
    ("?", "Open keybindings menu", None),
    ("q", "Quit", "quit"),
]

REPOS_BINDINGS = [
    ("r", "Rotate", "do_rotate"),
    ("t", "Thaw", "do_thaw"),
    ("c", "Cleanup", "do_cleanup"),
    ("f", "Fix (repair metadata)", "do_repair"),
]

THAW_BINDINGS = [
    ("f", "Refreeze", "do_refreeze"),
]

BUCKET_BINDINGS: list[tuple[str, str, str | None]] = []
ILM_BINDINGS: list[tuple[str, str, str | None]] = []

NAV_BINDINGS = [
    ("j / down", "Move cursor down", None),
    ("k / up", "Move cursor up", None),
    ("enter", "Select item", None),
    ("esc", "Cancel / close", None),
]

PANEL_BINDINGS = {
    "repos": ("Repositories", REPOS_BINDINGS),
    "thaw-requests": ("Thaw Requests", THAW_BINDINGS),
    "buckets": ("Buckets", BUCKET_BINDINGS),
    "ilm-policies": ("ILM Policies", ILM_BINDINGS),
    "detail-scroll": ("Detail", []),
}


def _format_line(key: str, desc: str) -> str:
    return f"[bold #008a5e]{key:>14}[/bold #008a5e] {desc}"


def _make_separator() -> Option:
    if Separator is not None:
        return Separator()
    return Option("", disabled=True)


class HelpPanel(Vertical):
    """An absolutely-positioned help panel that floats over the layout.

    This is NOT a Screen or ModalScreen - it's a regular widget that
    lives in the app's compose tree and is toggled visible/hidden.
    Using absolute positioning, it floats on top of sibling widgets
    without removing them from the render.
    """

    DEFAULT_CSS = """
    HelpPanel {
        display: none;
        layer: overlay;
        width: 60;
        height: auto;
        max-height: 80%;
        border: solid #008a5e;
        border-title-color: #008a5e;
        border-title-style: bold;
        border-title-align: center;
        background: #1a1c21;
    }

    HelpPanel #help-list {
        background: #1a1c21;
        width: 100%;
        height: auto;
        max-height: 100%;
    }

    HelpPanel #help-list > .option-list--option-highlighted {
        background: #008a5e;
        color: white;
    }

    HelpPanel #help-list > .option-list--option {
        padding: 0 1;
    }

    HelpPanel #help-footer {
        width: 100%;
        height: 1;
        text-align: center;
        color: #7b7b7b;
        background: #252830;
    }
    """

    BINDINGS = [
        Binding("escape", "close_help", "Close", show=False, priority=True),
        Binding("question_mark", "close_help", "Close", show=False, priority=True),
    ]

    can_focus = False

    def __init__(self) -> None:
        super().__init__(id="help-panel")
        self._action_map: dict[str, str] = {}

    def compose(self) -> ComposeResult:
        self.border_title = "Keybindings"
        yield OptionList(id="help-list")
        yield Static("Execute: <enter> | Close: <esc>", id="help-footer")

    def toggle(self, focused_panel_id: str = "") -> None:
        """Toggle visibility. If showing, populate with context bindings."""
        if self.styles.display == "block":
            self.hide()
        else:
            self._populate(focused_panel_id)
            self.styles.display = "block"
            # Center the panel on screen
            try:
                screen_w = self.app.size.width
                screen_h = self.app.size.height
                panel_w = 60  # matches CSS width
                panel_h = min(screen_h * 80 // 100, 30)
                self.styles.offset = (
                    max(0, (screen_w - panel_w) // 2),
                    max(0, (screen_h - panel_h) // 2),
                )
            except Exception:
                pass
            self.query_one("#help-list", OptionList).focus()

    def hide(self) -> None:
        self.styles.display = "none"

    def _populate(self, focused_panel_id: str) -> None:
        """Fill the OptionList with context-sensitive bindings."""
        self._action_map.clear()
        opt_list = self.query_one("#help-list", OptionList)
        opt_list.clear_options()
        idx = 0

        # Panel-specific bindings
        panel_name, panel_binds = PANEL_BINDINGS.get(focused_panel_id, ("", []))
        if panel_binds:
            opt_list.add_option(_make_separator())
            opt_list.add_option(
                Option(
                    f"[bold #7b7b7b]{'--- ' + panel_name + ' ---':^56}[/bold #7b7b7b]",
                    disabled=True,
                )
            )
            for key, desc, action in panel_binds:
                opt_id = f"help-{idx}"
                opt_list.add_option(Option(_format_line(key, desc), id=opt_id))
                if action:
                    self._action_map[opt_id] = action
                idx += 1

        # Navigation
        opt_list.add_option(_make_separator())
        opt_list.add_option(
            Option(
                f"[bold #7b7b7b]{'--- Navigation ---':^56}[/bold #7b7b7b]",
                disabled=True,
            )
        )
        for key, desc, action in NAV_BINDINGS:
            opt_id = f"help-{idx}"
            opt_list.add_option(Option(_format_line(key, desc), id=opt_id))
            if action:
                self._action_map[opt_id] = action
            idx += 1

        # Global
        opt_list.add_option(_make_separator())
        opt_list.add_option(
            Option(
                f"[bold #7b7b7b]{'--- Global ---':^56}[/bold #7b7b7b]",
                disabled=True,
            )
        )
        for key, desc, action in GLOBAL_BINDINGS:
            opt_id = f"help-{idx}"
            opt_list.add_option(Option(_format_line(key, desc), id=opt_id))
            if action:
                self._action_map[opt_id] = action
            idx += 1

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        """Execute action when item is selected (enter or click)."""
        opt_id = event.option.id
        action_name = self._action_map.get(opt_id or "") if opt_id else None
        self.hide()
        if action_name:
            if action_name == "quit":
                self.app.action_quit()
            elif action_name == "refresh":
                if hasattr(self.app, "action_refresh"):
                    self.app.action_refresh()
            elif hasattr(self.app, f"action_do_{action_name}"):
                getattr(self.app, f"action_do_{action_name}")()

    def action_close_help(self) -> None:
        self.hide()
