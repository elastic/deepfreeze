"""Logs screen - Display action history."""

from textual.screen import Screen
from textual.containers import Vertical, Horizontal
from textual.widgets import Label, DataTable, Button, Static
from textual.reactive import reactive


class StatusBadge(Static):
    """Badge showing action status with color."""

    STATUS_COLORS = {
        "success": ("#008a5e", "✓"),
        "failed": ("#c61e25", "✗"),
        "running": ("#facb3d", "⏳"),
    }

    def __init__(self, status: str = "unknown"):
        super().__init__()
        self.status = status.lower()

    def on_mount(self):
        self.update_badge()

    def update_badge(self):
        color, icon = self.STATUS_COLORS.get(self.status, ("#7b7b7b", "?"))
        self.update(f"[{color}]{icon} {self.status.upper()}[/{color}]")


class LogsScreen(Screen):
    """Screen for viewing action history and logs."""

    BINDINGS = [
        ("r", "refresh", "Refresh"),
        ("a", "filter_all", "All"),
        ("s", "filter_success", "Success"),
        ("f", "filter_failed", "Failed"),
        ("1", "switch_overview", "Overview"),
        ("2", "switch_repos", "Repos"),
        ("3", "switch_thaw", "Thaw"),
        ("4", "switch_ops", "Operations"),
        ("5", "switch_config", "Config"),
        ("6", "noop", ""),
    ]

    # Reactive data
    action_history = reactive([])
    filter_type = reactive("all")  # all, success, failed

    def compose(self):
        """Compose the logs screen."""
        with Vertical():
            # Header
            with Horizontal(classes="header-row"):
                yield Label("Action History", classes="screen-title")
                yield Label("Last 50 actions", id="history-count", classes="subtitle")

            # Filter buttons
            with Horizontal(classes="filter-row"):
                yield Button("All", id="btn-filter-all", variant="primary")
                yield Button("Success", id="btn-filter-success")
                yield Button("Failed", id="btn-filter-failed")

            # Action history table
            table = DataTable(id="history-table")
            table.add_columns(
                "Time", "Action", "Dry Run", "Status", "Summary", "Duration"
            )
            table.cursor_type = "row"
            yield table

            # Status bar
            yield Label(
                "Press [r] to refresh | Auto-refresh: ON",
                id="status-bar",
                classes="status-bar",
            )

    async def on_mount(self):
        """Called when screen is mounted."""
        await self.load_history()
        self.set_interval(
            30, lambda: self.run_worker(self.load_history())
        )  # Auto-refresh every 30 seconds

    async def load_history(self):
        """Load action history from service."""
        try:
            if hasattr(self.app, "service") and self.app.service:
                # Fetch real action history from service
                history = self.app.service.get_action_history(limit=50)

                self.action_history = [
                    {
                        "timestamp": entry.timestamp,
                        "action": entry.action,
                        "dry_run": entry.dry_run,
                        "success": entry.success,
                        "summary": entry.summary,
                        "duration_ms": entry.duration_ms
                        if hasattr(entry, "duration_ms")
                        else 0,
                    }
                    for entry in history
                ]

                self.update_table()
        except Exception as e:
            self.notify(f"Failed to load action history: {str(e)}", severity="error")
            self.action_history = []
            self.update_table()

    def update_table(self):
        """Update the history table with current filter."""
        table = self.query_one("#history-table", DataTable)
        table.clear()

        # Apply filter
        filtered = self.action_history
        if self.filter_type == "success":
            filtered = [a for a in filtered if a.get("success")]
        elif self.filter_type == "failed":
            filtered = [a for a in filtered if not a.get("success")]

        # Limit to 50
        filtered = filtered[:50]

        for action in filtered:
            timestamp = action.get("timestamp")
            time_str = timestamp.strftime("%H:%M:%S") if timestamp else "—"

            status_badge = StatusBadge("success" if action.get("success") else "failed")

            duration_ms = action.get("duration_ms", 0)
            if duration_ms < 1000:
                duration_str = f"{duration_ms}ms"
            else:
                duration_str = f"{duration_ms / 1000:.1f}s"

            table.add_row(
                time_str,
                action.get("action", "—"),
                "✓" if action.get("dry_run") else "—",
                status_badge,
                action.get("summary", "—")[:40],
                duration_str,
            )

        # Update count label
        self.query_one("#history-count", Label).update(
            f"Showing {len(filtered)} of {len(self.action_history)} actions"
        )

    def action_refresh(self):
        """Refresh action history."""
        self.run_worker(self.load_history())

    def action_filter_all(self):
        """Show all actions."""
        self.filter_type = "all"
        self.update_button_styles()
        self.update_table()

    def action_filter_success(self):
        """Show only successful actions."""
        self.filter_type = "success"
        self.update_button_styles()
        self.update_table()

    def action_filter_failed(self):
        """Show only failed actions."""
        self.filter_type = "failed"
        self.update_button_styles()
        self.update_table()

    def update_button_styles(self):
        """Update button styles based on active filter."""
        buttons = {
            "all": self.query_one("#btn-filter-all", Button),
            "success": self.query_one("#btn-filter-success", Button),
            "failed": self.query_one("#btn-filter-failed", Button),
        }
        for filter_type, button in buttons.items():
            button.variant = "primary" if self.filter_type == filter_type else "default"

    def action_switch_overview(self):
        """Switch to overview screen."""
        self.app.push_screen("overview")

    def action_switch_repos(self):
        """Switch to repositories screen."""
        self.app.push_screen("repositories")

    def action_switch_thaw(self):
        """Switch to thaw screen."""
        self.app.push_screen("thaw")

    def action_switch_ops(self):
        """Switch to operations screen."""
        self.app.push_screen("operations")

    def action_switch_config(self):
        """Switch to configuration screen."""
        self.app.push_screen("configuration")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle filter button presses."""
        button_id = event.button.id
        if button_id == "btn-filter-all":
            self.action_filter_all()
        elif button_id == "btn-filter-success":
            self.action_filter_success()
        elif button_id == "btn-filter-failed":
            self.action_filter_failed()

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Handle row selection - could show action details."""
        pass
