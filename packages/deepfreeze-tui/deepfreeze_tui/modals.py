"""Help overlay widget for deepfreeze TUI.

Uses a docked widget with `display: none` toggled on/off instead of a
ModalScreen, so the underlying panels remain visible behind it.
"""

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container
from textual.widgets import OptionList, Static
from textual.widgets.option_list import Option

try:
    from textual.widgets.option_list import Separator
except ImportError:
    Separator = None  # type: ignore[assignment, misc]


# -- Binding definitions by context --
# Each tuple: (key, description, action_name_or_None)

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

# Map panel IDs to their context bindings
PANEL_BINDINGS = {
    "repos": ("Repositories", REPOS_BINDINGS),
    "thaw-requests": ("Thaw Requests", THAW_BINDINGS),
    "buckets": ("Buckets", BUCKET_BINDINGS),
    "ilm-policies": ("ILM Policies", ILM_BINDINGS),
    "detail-scroll": ("Detail", []),
}


def _format_line(key: str, desc: str) -> str:
    """Format a keybinding line for display."""
    return f"[bold #008a5e]{key:>14}[/bold #008a5e] {desc}"


def _make_separator() -> Option:
    """Create a separator compatible with all Textual versions."""
    if Separator is not None:
        return Separator()
    return Option("", disabled=True)


class HelpOverlay(Container):
    """A floating help overlay that sits on top of the app layout.

    Toggled visible/hidden. Does not replace the screen underneath.
    """

    DEFAULT_CSS = """
    HelpOverlay {
        display: none;
        dock: top;
        layer: overlay;
        width: 100%;
        height: 100%;
        align: center middle;
    }

    #help-box {
        width: 60;
        max-height: 80%;
        height: auto;
        border: solid #008a5e;
        border-title-color: #008a5e;
        border-title-style: bold;
        border-title-align: center;
        background: #1a1c21;
    }

    #help-list {
        background: #1a1c21;
        width: 100%;
        height: auto;
        max-height: 100%;
    }

    #help-list > .option-list--option-highlighted {
        background: #008a5e;
        color: white;
    }

    #help-list > .option-list--option {
        padding: 0 1;
    }

    #help-footer {
        width: 100%;
        height: 1;
        text-align: center;
        color: #7b7b7b;
        background: #252830;
    }
    """

    BINDINGS = [
        Binding("escape", "close_help", "Close", show=False),
        Binding("question_mark", "close_help", "Close", show=False),
    ]

    can_focus = False

    def __init__(self) -> None:
        super().__init__(id="help-overlay")
        self._action_map: dict[str, str] = {}

    def compose(self) -> ComposeResult:
        with Container(id="help-box") as box:
            box.border_title = "Keybindings"
            yield OptionList(id="help-list")
            yield Static("Execute: <enter> | Close: <esc>", id="help-footer")

    def show(self, focused_panel_id: str = "") -> None:
        """Show the help overlay with context-sensitive bindings."""
        self._action_map.clear()
        option_list = self.query_one("#help-list", OptionList)
        option_list.clear_options()

        idx = 0

        # Panel-specific bindings
        panel_name, panel_binds = PANEL_BINDINGS.get(focused_panel_id, ("", []))
        if panel_binds:
            option_list.add_option(_make_separator())
            option_list.add_option(
                Option(
                    f"[bold #7b7b7b]{'--- ' + panel_name + ' ---':^56}[/bold #7b7b7b]",
                    disabled=True,
                )
            )
            for key, desc, action in panel_binds:
                opt_id = f"help-{idx}"
                option_list.add_option(Option(_format_line(key, desc), id=opt_id))
                if action:
                    self._action_map[opt_id] = action
                idx += 1

        # Navigation
        option_list.add_option(_make_separator())
        option_list.add_option(
            Option(
                f"[bold #7b7b7b]{'--- Navigation ---':^56}[/bold #7b7b7b]",
                disabled=True,
            )
        )
        for key, desc, action in NAV_BINDINGS:
            opt_id = f"help-{idx}"
            option_list.add_option(Option(_format_line(key, desc), id=opt_id))
            if action:
                self._action_map[opt_id] = action
            idx += 1

        # Global
        option_list.add_option(_make_separator())
        option_list.add_option(
            Option(
                f"[bold #7b7b7b]{'--- Global ---':^56}[/bold #7b7b7b]",
                disabled=True,
            )
        )
        for key, desc, action in GLOBAL_BINDINGS:
            opt_id = f"help-{idx}"
            option_list.add_option(Option(_format_line(key, desc), id=opt_id))
            if action:
                self._action_map[opt_id] = action
            idx += 1

        # Show and focus
        self.styles.display = "block"
        option_list.focus()

    def hide(self) -> None:
        """Hide the help overlay."""
        self.styles.display = "none"

    @property
    def is_visible(self) -> bool:
        """Check if help overlay is currently shown."""
        return self.styles.display != "none"

    def action_close_help(self) -> None:
        """Close the help overlay."""
        self.hide()

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        """Execute the action when an item is selected."""
        opt_id = event.option.id
        action_name = self._action_map.get(opt_id or "") if opt_id else None
        self.hide()
        if action_name:
            # Dispatch to app
            if action_name == "quit":
                self.app.action_quit()
            elif action_name == "refresh":
                self.app.action_refresh()
            elif hasattr(self.app, f"action_do_{action_name}"):
                getattr(self.app, f"action_do_{action_name}")()
            elif hasattr(self.app, f"action_{action_name}"):
                getattr(self.app, f"action_{action_name}")()
