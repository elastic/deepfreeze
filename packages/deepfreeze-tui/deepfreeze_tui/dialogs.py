"""Input dialogs for deepfreeze TUI actions."""

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Static


class ThawDialog(ModalScreen[dict | None]):
    """Dialog to collect thaw request parameters."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
    ]

    DEFAULT_CSS = """
    ThawDialog {
        align: center middle;
        background: #1a1c21 80%;
    }

    #thaw-dialog {
        width: 50;
        height: auto;
        border: solid #008a5e;
        border-title-color: #008a5e;
        border-title-style: bold;
        border-title-align: center;
        background: #1a1c21;
        padding: 1 2;
    }

    #thaw-dialog Label {
        margin-top: 1;
        color: #dfe5ef;
    }

    #thaw-dialog Input {
        margin-bottom: 1;
    }

    #thaw-dialog .dialog-buttons {
        layout: horizontal;
        height: 3;
        margin-top: 1;
        align: center middle;
    }

    #thaw-dialog Button {
        margin: 0 1;
    }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="thaw-dialog") as dialog:
            dialog.border_title = "Create Thaw Request"

            yield Label("Start date (YYYY-MM-DD):")
            yield Input(placeholder="2025-01-01", id="start-date")

            yield Label("End date (YYYY-MM-DD):")
            yield Input(placeholder="2025-03-31", id="end-date")

            yield Label("Restore duration (days):")
            yield Input(placeholder="7", id="duration", value="7")

            with Vertical(classes="dialog-buttons"):
                yield Button("Create", variant="success", id="btn-create")
                yield Button("Cancel", variant="default", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-create":
            start = self.query_one("#start-date", Input).value.strip()
            end = self.query_one("#end-date", Input).value.strip()
            duration_str = self.query_one("#duration", Input).value.strip()

            if not start or not end:
                self.notify("Start and end dates are required", severity="error")
                return

            try:
                duration = int(duration_str) if duration_str else 7
            except ValueError:
                self.notify("Duration must be a number", severity="error")
                return

            self.dismiss(
                {
                    "start_date": start,
                    "end_date": end,
                    "duration": duration,
                }
            )
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)
