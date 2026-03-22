"""Configuration screen - Display deepfreeze configuration and settings."""

from textual.screen import Screen
from textual.containers import Vertical, Horizontal, Grid
from textual.widgets import Label, DataTable, Static
from textual.reactive import reactive


class ConfigValue(Static):
    """Display a configuration value with label."""

    def __init__(self, label: str, value: str = "—"):
        super().__init__()
        self.label_text = label
        self.value_text = value

    def compose(self):
        with Horizontal(classes="config-row"):
            yield Label(f"{self.label_text}:", classes="config-label")
            yield Label(self.value_text, classes="config-value")


class ConfigurationScreen(Screen):
    """Screen for viewing deepfreeze configuration."""

    BINDINGS = [
        ("1", "switch_overview", "Overview"),
        ("2", "switch_repos", "Repos"),
        ("3", "switch_thaw", "Thaw"),
        ("4", "switch_ops", "Operations"),
        ("5", "noop", ""),
        ("6", "switch_logs", "Logs"),
    ]

    # Reactive data
    settings = reactive({})
    ilm_policies = reactive([])
    buckets = reactive([])
    index_templates = reactive([])

    def compose(self):
        """Compose the configuration screen."""
        with Vertical():
            # Header
            with Horizontal(classes="header-row"):
                yield Label("Configuration", classes="screen-title")
                yield Label("View-only configuration display", classes="subtitle")

            # Settings section
            yield Label("Settings", classes="section-title")
            with Grid(classes="config-grid"):
                yield ConfigValue("Repository Prefix", "—").data_bind(
                    value=ConfigurationScreen.settings
                )
                yield ConfigValue("Bucket Prefix", "—").data_bind(
                    value=ConfigurationScreen.settings
                )
                yield ConfigValue("Provider", "—").data_bind(
                    value=ConfigurationScreen.settings
                )
                yield ConfigValue("Base Path Prefix", "—").data_bind(
                    value=ConfigurationScreen.settings
                )
                yield ConfigValue("Rotate By", "—").data_bind(
                    value=ConfigurationScreen.settings
                )
                yield ConfigValue("ILM Policy", "—").data_bind(
                    value=ConfigurationScreen.settings
                )

            # ILM Policies section
            yield Label("ILM Policies", classes="section-title")
            ilm_table = DataTable(id="ilm-table")
            ilm_table.add_columns("Name", "Repository", "Searchable Snapshot")
            ilm_table.add_row("—", "—", "—")
            yield ilm_table

            # Buckets section
            yield Label("Buckets", classes="section-title")
            bucket_table = DataTable(id="bucket-table")
            bucket_table.add_columns("Name", "Provider", "Region")
            bucket_table.add_row("—", "—", "—")
            yield bucket_table

            # Index Templates section
            yield Label("Index Templates", classes="section-title")
            template_table = DataTable(id="template-table")
            template_table.add_columns("Name", "Pattern", "ILM Policy")
            template_table.add_row("—", "—", "—")
            yield template_table

    def on_mount(self):
        """Called when screen is mounted."""
        self.load_configuration()

    def load_configuration(self):
        """Load configuration data from service."""
        # In real implementation, would call self.app.service.get_status()
        # to get settings, buckets, ILM policies, etc.
        # For now, use sample data
        self.settings = {
            "repo_prefix": "deepfreeze",
            "bucket_prefix": "deepfreeze",
            "provider": "s3",
            "base_path": "snapshots",
            "rotate_by": "month",
            "ilm_policy": "deepfreeze-policy",
        }

        self.ilm_policies = [
            {
                "name": "deepfreeze-policy",
                "repo": "deepfreeze-000001",
                "searchable_snapshot": True,
            },
            {
                "name": "archive-policy",
                "repo": None,
                "searchable_snapshot": False,
            },
        ]

        self.buckets = [
            {
                "name": "deepfreeze-production",
                "provider": "s3",
                "region": "us-east-1",
            },
            {
                "name": "deepfreeze-archive",
                "provider": "s3",
                "region": "us-west-2",
            },
        ]

        self.index_templates = [
            {
                "name": "deepfreeze-template",
                "pattern": "deepfreeze-*",
                "ilm_policy": "deepfreeze-policy",
            },
        ]

        self.update_tables()

    def update_tables(self):
        """Update all data tables."""
        # Update ILM policies table
        ilm_table = self.query_one("#ilm-table", DataTable)
        ilm_table.clear()
        for policy in self.ilm_policies:
            ilm_table.add_row(
                policy.get("name", "—"),
                policy.get("repo", "—") or "—",
                "✓" if policy.get("searchable_snapshot") else "—",
            )

        # Update buckets table
        bucket_table = self.query_one("#bucket-table", DataTable)
        bucket_table.clear()
        for bucket in self.buckets:
            bucket_table.add_row(
                bucket.get("name", "—"),
                bucket.get("provider", "—"),
                bucket.get("region", "—") or "—",
            )

        # Update index templates table
        template_table = self.query_one("#template-table", DataTable)
        template_table.clear()
        for template in self.index_templates:
            template_table.add_row(
                template.get("name", "—"),
                template.get("pattern", "—"),
                template.get("ilm_policy", "—") or "—",
            )

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

    def action_switch_logs(self):
        """Switch to logs screen."""
        self.app.push_screen("logs")
