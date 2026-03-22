"""Modal screens for deepfreeze TUI."""

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import OptionList, Static
from textual.widgets.option_list import Option

try:
    from textual.widgets.option_list import Separator
except ImportError:
    # Older Textual versions don't have Separator; use a disabled Option instead
    Separator = None  # type: ignore[assignment, misc]


# -- Binding definitions by context --
# Each tuple: (key, description, action_name_or_None)
# action_name is used for executing when clicked/entered; None = info only

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
    """Create a separator element compatible with all Textual versions."""
    if Separator is not None:
        return Separator()
    # Fallback: a disabled blank option
    return Option("", disabled=True)


class HelpModal(ModalScreen[str | None]):
    """Centered help modal showing context-sensitive keybindings.

    Overlays on top of the app without dimming the background.
    Each item is navigable via keyboard and clickable via mouse.
    Selecting an actionable item dismisses the modal and runs the action.
    """

    BINDINGS = [
        Binding("escape", "dismiss_modal", "Close", show=False),
        Binding("question_mark", "dismiss_modal", "Close", show=False),
    ]

    DEFAULT_CSS = """
    HelpModal {
        align: center middle;
        background: transparent;
    }

    #help-container {
        width: 60;
        max-height: 80%;
        border: solid #008a5e;
        border-title-color: #008a5e;
        border-title-style: bold;
        border-title-align: center;
        background: #1a1c21;
        padding: 0;
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

    #help-list > .option-list--separator {
        color: #7b7b7b;
    }

    #help-footer {
        width: 100%;
        height: 1;
        text-align: center;
        color: #7b7b7b;
        background: #252830;
    }
    """

    def __init__(self, focused_panel_id: str = "") -> None:
        super().__init__()
        self.focused_panel_id = focused_panel_id
        # Map option IDs to action names
        self._action_map: dict[str, str] = {}

    def compose(self) -> ComposeResult:
        with VerticalScroll(id="help-container") as container:
            container.border_title = "Keybindings"

            options: list[Option] = []
            idx = 0

            # Panel-specific bindings
            panel_name, panel_binds = PANEL_BINDINGS.get(
                self.focused_panel_id, ("", [])
            )
            if panel_binds:
                options.append(_make_separator())
                options.append(
                    Option(
                        f"[bold #7b7b7b]{'--- ' + panel_name + ' ---':^56}[/bold #7b7b7b]",
                        disabled=True,
                    )
                )
                for key, desc, action in panel_binds:
                    opt_id = f"help-{idx}"
                    options.append(Option(_format_line(key, desc), id=opt_id))
                    if action:
                        self._action_map[opt_id] = action
                    idx += 1

            # Navigation
            options.append(_make_separator())
            options.append(
                Option(
                    f"[bold #7b7b7b]{'--- Navigation ---':^56}[/bold #7b7b7b]",
                    disabled=True,
                )
            )
            for key, desc, action in NAV_BINDINGS:
                opt_id = f"help-{idx}"
                options.append(Option(_format_line(key, desc), id=opt_id))
                if action:
                    self._action_map[opt_id] = action
                idx += 1

            # Global
            options.append(_make_separator())
            options.append(
                Option(
                    f"[bold #7b7b7b]{'--- Global ---':^56}[/bold #7b7b7b]",
                    disabled=True,
                )
            )
            for key, desc, action in GLOBAL_BINDINGS:
                opt_id = f"help-{idx}"
                options.append(Option(_format_line(key, desc), id=opt_id))
                if action:
                    self._action_map[opt_id] = action
                idx += 1

            yield OptionList(*options, id="help-list")
            yield Static("Execute: <enter> | Close: <esc>", id="help-footer")

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        """Execute the action when an item is selected (enter or click)."""
        opt_id = event.option.id
        if opt_id and opt_id in self._action_map:
            self.dismiss(self._action_map[opt_id])
        else:
            # Non-actionable item, just close
            self.dismiss(None)

    def action_dismiss_modal(self) -> None:
        """Close the modal."""
        self.dismiss(None)
