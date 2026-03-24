"""Input dialogs for deepfreeze TUI actions.

All dialogs use layer-based overlays (not ModalScreen) so the
panels underneath remain visible while the user fills in the form.
"""

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, Input, Label


class ThawDialog(Vertical):
    """Overlay dialog to collect thaw request parameters.

    Floats on top of the layout using the 'overlay' layer,
    same approach as HelpPanel.
    """

    DEFAULT_CSS = """
    ThawDialog {
        display: none;
        layer: overlay;
        width: 60;
        height: auto;
        border: solid #008a5e;
        border-title-color: #008a5e;
        border-title-style: bold;
        border-title-align: center;
        background: #1a1c21;
        padding: 1 2;
    }

    ThawDialog Label {
        margin-top: 1;
        color: #dfe5ef;
    }

    ThawDialog Input {
        margin-bottom: 1;
    }

    ThawDialog .dialog-buttons {
        height: 3;
        margin-top: 1;
        align: center middle;
    }

    ThawDialog Button {
        margin: 0 1;
    }
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False, priority=True),
    ]

    can_focus_children = True

    def __init__(self) -> None:
        super().__init__(id="thaw-dialog")
        self._callback = None

    def compose(self) -> ComposeResult:
        self.border_title = "Create Thaw Request"

        yield Label("Start date (YYYY-MM-DD or YYYY-MM-DDTHH:MM):")
        yield Input(placeholder="2025-01-01T08:00", id="start-date")

        yield Label("End date (YYYY-MM-DD or YYYY-MM-DDTHH:MM):")
        yield Input(placeholder="2025-03-31T17:00", id="end-date")

        yield Label("Restore duration (days):")
        yield Input(placeholder="30", id="duration", value="30")

        with Horizontal(classes="dialog-buttons"):
            yield Button("Create", variant="success", id="btn-create")
            yield Button("Cancel", variant="default", id="btn-cancel")

    def show(self, callback) -> None:
        """Show the dialog and set the callback for when it completes."""
        self._callback = callback
        # Clear previous values
        self.query_one("#start-date", Input).value = ""
        self.query_one("#end-date", Input).value = ""
        self.query_one("#duration", Input).value = "30"
        # Show and focus first input
        self.styles.display = "block"
        try:
            screen_w = self.app.size.width
            screen_h = self.app.size.height
            panel_w = 60
            self.styles.offset = (
                max(0, (screen_w - panel_w) // 2),
                max(0, (screen_h - 20) // 2),
            )
        except Exception:
            pass
        self.query_one("#start-date", Input).focus()

    def hide(self) -> None:
        """Hide the dialog."""
        self.styles.display = "none"

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-create":
            self._submit()
        else:
            self._cancel()

    def _submit(self) -> None:
        """Validate and submit the form."""
        start = self.query_one("#start-date", Input).value.strip()
        end = self.query_one("#end-date", Input).value.strip()
        duration_str = self.query_one("#duration", Input).value.strip()

        if not start or not end:
            self.app.notify("Start and end dates are required", severity="error")
            return

        try:
            duration = int(duration_str) if duration_str else 7
        except ValueError:
            self.app.notify("Duration must be a number", severity="error")
            return

        self.hide()
        if self._callback:
            self._callback(
                {
                    "start_date": start,
                    "end_date": end,
                    "duration": duration,
                }
            )

    def _cancel(self) -> None:
        """Cancel and close."""
        self.hide()

    def action_cancel(self) -> None:
        self._cancel()


class ConfirmDialog(Vertical):
    """Reusable confirmation overlay dialog.

    Floats on the 'overlay' layer like HelpPanel and ThawDialog.
    Shows a message and Yes/No buttons. Calls back with True or False.
    """

    DEFAULT_CSS = """
    ConfirmDialog {
        display: none;
        layer: overlay;
        width: 50;
        height: auto;
        border: solid #008a5e;
        border-title-color: #008a5e;
        border-title-style: bold;
        border-title-align: center;
        background: #1a1c21;
        padding: 1 2;
    }

    ConfirmDialog #confirm-message {
        margin: 1 0;
        color: #dfe5ef;
        text-align: center;
    }

    ConfirmDialog .dialog-buttons {
        height: 3;
        margin-top: 1;
        align: center middle;
    }

    ConfirmDialog Button {
        margin: 0 1;
    }
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False, priority=True),
        Binding("y", "confirm_yes", "Yes", show=False, priority=True),
        Binding("n", "cancel", "No", show=False, priority=True),
    ]

    def __init__(self) -> None:
        super().__init__(id="confirm-dialog")
        self._callback = None

    def compose(self) -> ComposeResult:
        self.border_title = "Confirm"
        yield Label("Are you sure?", id="confirm-message")
        with Horizontal(classes="dialog-buttons"):
            yield Button("[Y]es", variant="success", id="btn-yes")
            yield Button("[N]o", variant="default", id="btn-no")

    def show(self, message: str, title: str = "Confirm", callback=None) -> None:
        """Show the confirmation dialog."""
        self._callback = callback
        self.border_title = title
        self.query_one("#confirm-message", Label).update(message)
        self.styles.display = "block"
        try:
            screen_w = self.app.size.width
            screen_h = self.app.size.height
            panel_w = 50
            self.styles.offset = (
                max(0, (screen_w - panel_w) // 2),
                max(0, (screen_h - 10) // 2),
            )
        except Exception:
            pass
        self.query_one("#btn-yes", Button).focus()

    def hide(self) -> None:
        self.styles.display = "none"

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-yes":
            self.hide()
            if self._callback:
                self._callback(True)
        else:
            self.hide()
            if self._callback:
                self._callback(False)

    def action_confirm_yes(self) -> None:
        self.hide()
        if self._callback:
            self._callback(True)

    def action_cancel(self) -> None:
        self.hide()
        if self._callback:
            self._callback(False)
