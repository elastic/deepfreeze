"""Main Textual app for deepfreeze TUI."""

from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, Static, TabbedContent, TabPane
from textual.containers import Vertical
from textual.reactive import reactive

from deepfreeze_service import DeepfreezeService

# Import screens
from .screens.overview import OverviewScreen
from .screens.repositories import RepositoriesScreen
from .screens.thaw import ThawScreen
from .screens.operations import OperationsScreen
from .screens.configuration import ConfigurationScreen
from .screens.logs import LogsScreen


class DeepfreezeApp(App):
    """Main Textual application for deepfreeze."""

    # CSS path for styling
    CSS_PATH = "styles/theme.tcss"

    # Enable textual's built-in command palette
    ENABLE_COMMAND_PALETTE = True

    # Screen navigation bindings
    BINDINGS = [
        ("q", "quit", "Quit"),
        ("r", "refresh", "Refresh"),
        ("?", "help", "Help"),
        ("1", "goto_overview", "Overview"),
        ("2", "goto_repositories", "Repositories"),
        ("3", "goto_thaw", "Thaw"),
        ("4", "goto_operations", "Operations"),
        ("5", "goto_configuration", "Configuration"),
        ("6", "goto_logs", "Logs"),
    ]

    # Reactive properties
    current_screen_id = reactive("overview")
    connection_status = reactive("connecting")

    SCREENS = {
        "overview": OverviewScreen,
        "repositories": RepositoriesScreen,
        "thaw": ThawScreen,
        "operations": OperationsScreen,
        "configuration": ConfigurationScreen,
        "logs": LogsScreen,
    }

    def __init__(self, config_path=None, refresh_interval=30):
        super().__init__()
        self.config_path = config_path
        self.refresh_interval = refresh_interval
        self.service: DeepfreezeService = None
        self._refresh_timer = None

    def compose(self) -> ComposeResult:
        """Compose the app layout."""
        yield Header(show_clock=True)

        # Connection status bar
        with Vertical(classes="status-bar"):
            yield Static(
                "[yellow]⚡ Connecting to Elasticsearch...[/yellow]",
                id="connection-status",
                classes="connection-status",
            )

        # Main content area - will show the current screen
        yield Static(id="main-content")

        yield Footer()

    def on_mount(self):
        """Initialize the app on mount."""
        self.initialize_service()
        self.push_screen("overview")
        self.start_refresh_timer()

    def initialize_service(self):
        """Initialize the deepfreeze service."""
        try:
            self.service = DeepfreezeService(
                config_path=self.config_path,
                polling_config={
                    "enabled": True,
                    "interval_seconds": self.refresh_interval,
                },
            )
            self.connection_status = "connected"
            self.update_connection_status()
        except Exception as e:
            self.connection_status = f"error: {e}"
            self.update_connection_status()

    def update_connection_status(self):
        """Update the connection status display."""
        status_widget = self.query_one("#connection-status", Static)
        if self.connection_status == "connected":
            status_widget.update("[green]✓ Connected to Elasticsearch[/green]")
        elif self.connection_status == "connecting":
            status_widget.update("[yellow]⚡ Connecting to Elasticsearch...[/yellow]")
        else:
            status_widget.update(f"[red]✗ {self.connection_status}[/red]")

    def start_refresh_timer(self):
        """Start the auto-refresh timer."""
        if self.refresh_interval > 0:
            self._refresh_timer = self.set_interval(
                self.refresh_interval, self.refresh_status
            )

    def refresh_status(self):
        """Refresh current screen's status data."""
        # Get the current screen and update its data
        current = self.screen
        if hasattr(current, "update_data"):
            # In real implementation, would fetch from service
            # current.update_data(status_data)
            pass

    def action_refresh(self):
        """Manually refresh status."""
        self.refresh_status()

    def action_help(self):
        """Show help dialog."""
        # Could show a modal with keyboard shortcuts
        self.notify(
            "Keyboard Shortcuts:\n"
            "1-6: Switch screens\n"
            "r: Refresh\n"
            "q: Quit\n"
            "?: Show this help",
            title="Help",
            severity="information",
        )

    # Screen navigation actions
    def action_goto_overview(self):
        """Navigate to overview screen."""
        self.current_screen_id = "overview"
        self.push_screen("overview")

    def action_goto_repositories(self):
        """Navigate to repositories screen."""
        self.current_screen_id = "repositories"
        self.push_screen("repositories")

    def action_goto_thaw(self):
        """Navigate to thaw screen."""
        self.current_screen_id = "thaw"
        self.push_screen("thaw")

    def action_goto_operations(self):
        """Navigate to operations screen."""
        self.current_screen_id = "operations"
        self.push_screen("operations")

    def action_goto_configuration(self):
        """Navigate to configuration screen."""
        self.current_screen_id = "configuration"
        self.push_screen("configuration")

    def action_goto_logs(self):
        """Navigate to logs screen."""
        self.current_screen_id = "logs"
        self.push_screen("logs")

    def watch_current_screen_id(self, screen_id: str):
        """Watch for screen changes to update UI."""
        # Could update header or breadcrumb here
        pass
