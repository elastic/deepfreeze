"""Overview screen - Main dashboard showing system health."""

from textual.screen import Screen
from textual.containers import Vertical, Horizontal, Grid
from textual.widgets import Static, Button, DataTable, Label, ProgressBar
from textual.reactive import reactive
from rich.text import Text
from rich.panel import Panel


class HealthBadge(Static):
    """A badge showing health status with color."""

    def __init__(self, label: str, status: str = "unknown"):
        super().__init__()
        self.label = label
        self.status = status

    def on_mount(self):
        self.update_badge()

    def update_badge(self):
        """Update badge appearance based on status."""
        colors = {
            "green": ("#008a5e", "✓"),
            "yellow": ("#facb3d", "⚠"),
            "red": ("#c61e25", "✗"),
            "unknown": ("#7b7b7b", "?"),
        }
        color, icon = colors.get(self.status, colors["unknown"])
        self.update(f"[{color}]{icon} {self.label}[/{color}]")


class StatCard(Static):
    """A card showing a statistic."""

    def __init__(self, title: str, value: str, subtitle: str = ""):
        super().__init__()
        self.title = title
        self.value = value
        self.subtitle = subtitle

    def compose(self):
        with Vertical():
            yield Label(self.title, classes="stat-title")
            yield Label(self.value, classes="stat-value")
            if self.subtitle:
                yield Label(self.subtitle, classes="stat-subtitle")


class OverviewScreen(Screen):
    """Main dashboard showing system overview."""

    BINDINGS = [
        ("r", "refresh", "Refresh"),
        ("1", "noop", ""),
        ("2", "switch_repos", "Repositories"),
        ("3", "switch_thaw", "Thaw"),
        ("4", "switch_ops", "Operations"),
        ("5", "switch_config", "Config"),
        ("6", "switch_logs", "Logs"),
    ]

    # Reactive data
    cluster_health = reactive({"status": "unknown", "name": "-"})
    repo_counts = reactive(
        {"active": 0, "frozen": 0, "thawing": 0, "thawed": 0, "expired": 0}
    )
    thaw_count = reactive(0)
    last_refresh = reactive("Never")

    def compose(self):
        """Compose the overview screen."""
        with Vertical():
            # Header with refresh indicator
            with Horizontal(classes="header-row"):
                yield Label("System Overview", classes="screen-title")
                yield Label(
                    "Last updated: Never",
                    id="refresh-indicator",
                    classes="refresh-time",
                )

            # Health badges row
            with Horizontal(classes="health-row"):
                self.health_badge_es = HealthBadge("ES Cluster", "unknown")
                yield self.health_badge_es
                self.health_badge_s3 = HealthBadge("S3 Storage", "unknown")
                yield self.health_badge_s3
                self.health_badge_ilm = HealthBadge("ILM Policies", "unknown")
                yield self.health_badge_ilm

            # Stats grid
            with Grid(classes="stats-grid"):
                self.stat_active = StatCard("Active Repos", "0", "Ready for writes")
                yield self.stat_active
                self.stat_frozen = StatCard("Frozen Repos", "0", "In cold storage")
                yield self.stat_frozen
                self.stat_thawing = StatCard("Thawing", "0", "Restore in progress")
                yield self.stat_thawing
                self.stat_thawed = StatCard("Thawed", "0", "Currently mounted")
                yield self.stat_thawed
                self.stat_expired = StatCard("Expired", "0", "Ready for cleanup")
                yield self.stat_expired
                self.stat_requests = StatCard("Thaw Requests", "0", "Active/completed")
                yield self.stat_requests

            # Recent activity table
            yield Label("Recent Activity", classes="section-title")
            table = DataTable(id="activity-table")
            table.add_columns("Time", "Action", "Status", "Summary")
            table.add_row("—", "—", "—", "Loading...")
            yield table

            # Quick actions
            with Horizontal(classes="quick-actions"):
                yield Button("🔄 Rotate", id="btn-rotate", variant="primary")
                yield Button("❄️ Thaw", id="btn-thaw", variant="primary")
                yield Button("🧹 Cleanup", id="btn-cleanup")
                yield Button("🔧 Repair", id="btn-repair")

    async def on_mount(self):
        """Called when screen is mounted."""
        self.update_health_display()
        await self.refresh_data()

    async def refresh_data(self):
        """Fetch real data from service and update display."""
        try:
            if hasattr(self.app, "service") and self.app.service:
                status = await self.app.service.get_status()
                self.update_data(status.model_dump())

                # Also fetch action history for the activity table
                history = self.app.service.get_action_history(limit=10)
                self.update_activity_table(history)
        except Exception as e:
            self.notify(f"Failed to load overview data: {str(e)}", severity="error")

    def update_activity_table(self, history):
        """Update the activity table with real action history."""
        table = self.query_one("#activity-table", DataTable)
        table.clear()

        if not history:
            table.add_row("—", "—", "—", "No recent activity")
            return

        for entry in history:
            status = "✓ Success" if entry.success else "✗ Failed"
            time_str = (
                entry.timestamp.strftime("%Y-%m-%d %H:%M") if entry.timestamp else "—"
            )
            table.add_row(
                time_str,
                entry.action,
                status,
                entry.summary[:50] if entry.summary else "—",
            )

    def update_health_display(self):
        """Update health badges based on cluster status."""
        health_badge = self.query_one(HealthBadge)
        health_badge.status = self.cluster_health.get("status", "unknown")
        health_badge.update_badge()

    def action_refresh(self):
        """Refresh status data."""
        # Run the async refresh in the background
        self.run_worker(self.refresh_data())

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

    def action_switch_logs(self):
        """Switch to logs screen."""
        self.app.push_screen("logs")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle quick action buttons."""
        button_id = event.button.id
        if button_id == "btn-rotate":
            self.app.push_screen("operations")
        elif button_id == "btn-thaw":
            self.app.push_screen("thaw")
        elif button_id == "btn-cleanup":
            self.app.push_screen("operations")
        elif button_id == "btn-repair":
            self.app.push_screen("operations")

    def update_data(self, status_data: dict):
        """Update screen with new status data."""
        # Update health badges
        if "cluster" in status_data and hasattr(self, "health_badge_es"):
            cluster = status_data["cluster"]
            self.health_badge_es.status = cluster.get("status", "unknown")
            self.health_badge_es.update_badge()

        # Update stat cards
        if "repositories" in status_data:
            repos = status_data["repositories"]
            counts = {
                "active": len([r for r in repos if r.get("state") == "active"]),
                "frozen": len([r for r in repos if r.get("state") == "frozen"]),
                "thawing": len([r for r in repos if r.get("state") == "thawing"]),
                "thawed": len([r for r in repos if r.get("state") == "thawed"]),
                "expired": len([r for r in repos if r.get("state") == "expired"]),
            }

            if hasattr(self, "stat_active"):
                self.stat_active.value = str(counts["active"])
            if hasattr(self, "stat_frozen"):
                self.stat_frozen.value = str(counts["frozen"])
            if hasattr(self, "stat_thawing"):
                self.stat_thawing.value = str(counts["thawing"])
            if hasattr(self, "stat_thawed"):
                self.stat_thawed.value = str(counts["thawed"])
            if hasattr(self, "stat_expired"):
                self.stat_expired.value = str(counts["expired"])

        # Update thaw requests count
        if "thaw_requests" in status_data and hasattr(self, "stat_requests"):
            self.stat_requests.value = str(len(status_data["thaw_requests"]))

        # Update refresh time
        from datetime import datetime

        self.last_refresh = datetime.now().strftime("%H:%M:%S")
        indicator = self.query_one("#refresh-indicator", Label)
        indicator.update(f"Last updated: {self.last_refresh}")
