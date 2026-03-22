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

    async def on_mount(self):
        """Called when screen is mounted."""
        await self.load_configuration()

    async def load_configuration(self):
        """Load configuration data from service."""
        try:
            if hasattr(self.app, "service") and self.app.service:
                # Fetch real status from service
                status = await self.app.service.get_status()

                # Extract settings
                if status.settings:
                    self.settings = {
                        "Repository Prefix": status.settings.repo_name_prefix,
                        "Bucket Prefix": status.settings.bucket_name_prefix,
                        "Provider": status.settings.provider,
                        "Base Path Prefix": status.settings.base_path_prefix,
                        "Rotate By": status.settings.rotate_by,
                        "ILM Policy": status.settings.ilm_policy_name or "—",
                    }
                else:
                    self.settings = {}

                # Extract buckets
                self.buckets = [
                    {
                        "name": bucket.name,
                        "provider": bucket.provider,
                        "region": bucket.region or "—",
                    }
                    for bucket in status.buckets
                ]

                # Extract ILM policies
                self.ilm_policies = [
                    {
                        "name": policy.name,
                        "repo": policy.repo or "—",
                        "searchable_snapshot": policy.searchable_snapshot_enabled,
                    }
                    for policy in status.ilm_policies
                ]

                self.index_templates = []  # Status doesn't include templates yet

                self.update_tables()
                self.update_config_display()
        except Exception as e:
            self.notify(f"Failed to load configuration: {str(e)}", severity="error")

    def update_config_display(self):
        """Update the config values display."""
        # This is a placeholder - the ConfigValue widgets would need
        # to be updated with the actual settings values
        pass

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
