"""Main Textual app for deepfreeze TUI.

This is a streamlined implementation demonstrating the foundation.
Full implementation would include all screens, widgets, and theming.
"""

from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, Static, Button, DataTable
from textual.containers import Horizontal, Vertical

from deepfreeze_service import DeepfreezeService


class DeepfreezeApp(App):
    """Main Textual application for deepfreeze."""

    CSS = """
    /* Elastic Dark Theme Foundation */
    Screen {
        background: #1a1c21;
        color: #dfe5ef;
    }
    
    Header {
        background: #1a1c21;
        color: #dfe5ef;
        height: 3;
    }
    
    Footer {
        background: #1a1c21;
        color: #dfe5ef;
    }
    
    Button {
        background: #0b64dd;
        color: white;
    }
    
    Button:hover {
        background: #0d74ff;
    }
    
    DataTable {
        background: #1a1c21;
        color: #dfe5ef;
    }
    
    .title {
        text-style: bold;
        color: #0b64dd;
    }
    
    .status-healthy {
        color: #008a5e;
    }
    
    .status-warning {
        color: #facb3d;
    }
    
    .status-danger {
        color: #c61e25;
    }
    """

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("r", "refresh", "Refresh"),
        ("1", "goto_overview", "Overview"),
        ("2", "goto_repos", "Repositories"),
        ("3", "goto_thaw", "Thaw"),
        ("4", "goto_ops", "Operations"),
        ("?", "help", "Help"),
    ]

    def __init__(self, config_path=None, refresh_interval=30):
        super().__init__()
        self.config_path = config_path
        self.refresh_interval = refresh_interval
        self.service = None

    def compose(self) -> ComposeResult:
        """Compose the UI."""
        yield Header(show_clock=True)

        with Vertical():
            yield Static("Deepfreeze Operator Dashboard", classes="title")
            yield Static("Initializing...")

            # This is a simplified placeholder view
            # Full implementation would include:
            # - Overview screen with health summary
            # - Repository browser with state filtering
            # - Thaw request management
            # - Operations panel for rotate/cleanup/etc
            # - Configuration viewer
            # - Logs/activity stream

            table = DataTable()
            table.add_columns("Repository", "State", "Bucket", "Status")
            table.add_row("deepfreeze-000001", "active", "my-bucket", "✓ Healthy")
            yield table

        yield Footer()

    def on_mount(self):
        """Initialize service on mount."""
        try:
            self.service = DeepfreezeService(config_path=self.config_path)
            self.query_one(Static, second=True).update("Connected to Elasticsearch")
        except Exception as e:
            self.query_one(Static, second=True).update(f"Error: {e}")

    def action_refresh(self):
        """Refresh status."""
        # Would trigger status refresh
        pass

    def action_goto_overview(self):
        """Navigate to overview."""
        pass

    def action_goto_repos(self):
        """Navigate to repositories."""
        pass

    def action_goto_thaw(self):
        """Navigate to thaw."""
        pass

    def action_goto_ops(self):
        """Navigate to operations."""
        pass
