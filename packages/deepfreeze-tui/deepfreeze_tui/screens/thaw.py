"""Thaw Requests screen - Create and monitor thaw operations."""

from textual.screen import Screen
from textual.containers import Vertical, Horizontal, Grid
from textual.widgets import (
    Static,
    Button,
    DataTable,
    Input,
    Label,
    TabbedContent,
    TabPane,
    Checkbox,
    Select,
)
from textual.reactive import reactive
from datetime import datetime, timedelta


class ThawStatusBadge(Static):
    """Badge showing thaw request status."""

    STATUS_COLORS = {
        "in_progress": ("#facb3d", "⏳"),
        "completed": ("#008a5e", "✓"),
        "failed": ("#c61e25", "✗"),
        "refrozen": ("#7b7b7b", "⊘"),
    }

    def __init__(self, status: str = "unknown"):
        super().__init__()
        self.status = status.lower()

    def on_mount(self):
        self.update_badge()

    def update_badge(self):
        color, icon = self.STATUS_COLORS.get(self.status, ("#7b7b7b", "?"))
        self.update(
            f"[{color}]{icon} {self.status.upper().replace('_', ' ')}[/{color}]"
        )


class ThawScreen(Screen):
    """Screen for managing thaw requests."""

    BINDINGS = [
        ("r", "refresh", "Refresh"),
        ("c", "create", "Create"),
        ("1", "switch_overview", "Overview"),
        ("2", "switch_repos", "Repos"),
        ("3", "noop", ""),
        ("k", "check", "Check"),
        ("f", "refreeze", "Refreeze"),
    ]

    thaw_requests = reactive([])
    selected_request = reactive(None)

    def compose(self):
        """Compose the thaw screen."""
        with TabbedContent(initial="list"):
            with TabPane("📋 List Requests", id="list"):
                with Vertical():
                    # Header
                    with Horizontal(classes="header-row"):
                        yield Label("Thaw Requests", classes="screen-title")
                        yield Button(
                            "➕ Create New", id="btn-create", variant="primary"
                        )

                    # Requests table
                    table = DataTable(id="requests-table")
                    table.add_columns(
                        "Status",
                        "Request ID",
                        "Date Range",
                        "Repositories",
                        "Created",
                        "Age",
                    )
                    table.cursor_type = "row"
                    yield table

                    # Selected request details
                    with Vertical(id="request-detail", classes="detail-panel"):
                        yield Label(
                            "Select a request to view details",
                            classes="detail-placeholder",
                        )

            with TabPane("➕ Create Request", id="create"):
                with Vertical(classes="form-container"):
                    yield Label("Create Thaw Request", classes="form-title")

                    with Grid(classes="form-grid"):
                        yield Label("Start Date:")
                        yield Input(placeholder="YYYY-MM-DD", id="input-start-date")

                        yield Label("End Date:")
                        yield Input(placeholder="YYYY-MM-DD", id="input-end-date")

                        yield Label("Duration (days):")
                        yield Input(value="7", id="input-duration")

                        yield Label("Retrieval Tier:")
                        yield Select(
                            [
                                ("Standard", "Standard"),
                                ("Bulk", "Bulk"),
                                ("Expedited", "Expedited"),
                            ],
                            value="Standard",
                            id="select-tier",
                        )

                    yield Checkbox("Wait for completion (sync mode)", id="chk-sync")
                    yield Checkbox("Dry run (preview only)", id="chk-dry-run")

                    with Horizontal(classes="form-actions"):
                        yield Button(
                            "❄️ Create Thaw Request",
                            id="btn-submit-thaw",
                            variant="primary",
                        )
                        yield Button("Cancel", id="btn-cancel-create")

    def on_mount(self):
        """Called when screen is mounted."""
        self.load_requests()

    def load_requests(self):
        """Load thaw requests from service."""
        # In real implementation, would call self.app.service.thaw_list()
        self.thaw_requests = [
            {
                "request_id": "thaw-001",
                "status": "completed",
                "start_date": "2024-01-01",
                "end_date": "2024-01-31",
                "repos": ["deepfreeze-000001"],
                "created_at": "2024-03-15",
                "age_days": 5,
            },
            {
                "request_id": "thaw-002",
                "status": "in_progress",
                "start_date": "2024-02-01",
                "end_date": "2024-02-28",
                "repos": ["deepfreeze-000002", "deepfreeze-000003"],
                "created_at": "2024-03-22",
                "age_days": 0,
            },
        ]
        self.update_table()

    def update_table(self):
        """Update the requests table."""
        table = self.query_one("#requests-table", DataTable)
        table.clear()

        for req in self.thaw_requests:
            status_badge = ThawStatusBadge(req.get("status", "unknown"))

            date_range = f"{req.get('start_date')} to {req.get('end_date')}"
            repos = ", ".join(req.get("repos", []))[:30]
            if len(repos) > 30:
                repos += "..."

            table.add_row(
                status_badge,
                req.get("request_id", "—"),
                date_range,
                repos,
                req.get("created_at", "—"),
                f"{req.get('age_days', 0)}d",
            )

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Handle request selection."""
        if event.row_key and event.row_key.value is not None:
            idx = int(event.row_key.value)
            if idx < len(self.thaw_requests):
                self.selected_request = self.thaw_requests[idx]
                self.show_request_details()

    def show_request_details(self):
        """Show details for selected request."""
        if not self.selected_request:
            return

        panel = self.query_one("#request-detail", Vertical)
        panel.remove_children()

        req = self.selected_request
        status = req.get("status", "unknown")

        with panel:
            yield Label(f"Request: {req.get('request_id')}", classes="detail-title")
            yield ThawStatusBadge(status)
            yield Label(f"Date Range: {req.get('start_date')} to {req.get('end_date')}")
            yield Label(f"Repositories: {', '.join(req.get('repos', []))}")
            yield Label(
                f"Created: {req.get('created_at')} ({req.get('age_days')} days ago)"
            )

            # Actions based on status
            with Horizontal(classes="detail-actions"):
                if status == "in_progress":
                    yield Button(
                        "🔄 Check Status", id="btn-check-status", variant="primary"
                    )
                elif status == "completed":
                    yield Button("🧊 Refreeze", id="btn-refreeze", variant="warning")
                elif status == "failed":
                    yield Button("🔄 Retry", id="btn-retry", variant="primary")

    def action_refresh(self):
        """Refresh requests."""
        self.load_requests()

    def action_create(self):
        """Switch to create tab."""
        self.query_one(TabbedContent).active = "create"

    def action_check(self):
        """Check status of selected request."""
        if self.selected_request:
            # Would call service.thaw_check()
            pass

    def action_refreeze(self):
        """Refreeze selected request."""
        if self.selected_request:
            # Would call service.refreeze()
            pass

    def action_switch_overview(self):
        """Switch to overview."""
        self.app.push_screen("overview")

    def action_switch_repos(self):
        """Switch to repositories."""
        self.app.push_screen("repositories")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle button presses."""
        button_id = event.button.id

        if button_id == "btn-create":
            self.query_one(TabbedContent).active = "create"
        elif button_id == "btn-submit-thaw":
            self.submit_thaw_request()
        elif button_id == "btn-cancel-create":
            self.query_one(TabbedContent).active = "list"
        elif button_id == "btn-check-status":
            self.action_check()
        elif button_id == "btn-refreeze":
            self.action_refreeze()

    def submit_thaw_request(self):
        """Submit the thaw request form."""
        # In real implementation, would gather form data and call service
        start_date = self.query_one("#input-start-date", Input).value
        end_date = self.query_one("#input-end-date", Input).value
        duration = self.query_one("#input-duration", Input).value

        # Validate dates
        try:
            datetime.strptime(start_date, "%Y-%m-%d")
            datetime.strptime(end_date, "%Y-%m-%d")
        except ValueError:
            # Show error
            return

        # Would call self.app.service.thaw_create(...)
        # For now, just switch back to list
        self.query_one(TabbedContent).active = "list"
        self.load_requests()
