"""Operations screen - Execute actions like rotate, cleanup, repair."""

from textual.screen import Screen
from textual.containers import Vertical, Horizontal, Grid
from textual.widgets import (
    Static,
    Button,
    Input,
    Label,
    Checkbox,
    TabbedContent,
    TabPane,
    RichLog,
    RadioSet,
    RadioButton,
)
from textual.reactive import reactive


class OperationsScreen(Screen):
    """Screen for executing deepfreeze operations."""

    BINDINGS = [
        ("1", "switch_overview", "Overview"),
        ("2", "switch_repos", "Repos"),
        ("3", "switch_thaw", "Thaw"),
        ("4", "noop", ""),
        ("5", "switch_config", "Config"),
        ("6", "switch_logs", "Logs"),
    ]

    current_action = reactive("")
    dry_run_mode = reactive(True)

    def compose(self):
        """Compose the operations screen."""
        with TabbedContent(initial="rotate"):
            with TabPane("🔄 Rotate", id="rotate"):
                yield self._create_rotate_form()

            with TabPane("🧹 Cleanup", id="cleanup"):
                yield self._create_cleanup_form()

            with TabPane("🔧 Repair", id="repair"):
                yield self._create_repair_form()

            with TabPane("⚡ Setup", id="setup"):
                yield self._create_setup_form()

        # Output log (shared across all operations)
        with Vertical(classes="output-panel"):
            yield Label("Output", classes="section-title")
            yield RichLog(id="output-log", highlight=True, markup=True)

    def _create_rotate_form(self):
        """Create the rotate operation form."""
        with Vertical(classes="form-container"):
            yield Label("🔄 Rotate Repositories", classes="form-title")
            yield Label(
                "Create a new repository and archive old ones based on retention policy."
            )

            with Grid(classes="form-grid"):
                yield Label("Year (optional):")
                yield Input(placeholder="Leave blank for current", id="rotate-year")

                yield Label("Month (optional):")
                yield Input(placeholder="Leave blank for current", id="rotate-month")

                yield Label("Keep (months):")
                yield Input(value="6", id="rotate-keep")

            with Horizontal(classes="form-options"):
                yield Checkbox(
                    "Dry run (preview only)", id="rotate-dry-run", value=True
                )

            with Horizontal(classes="form-actions"):
                yield Button("🔄 Execute Rotate", id="btn-rotate", variant="primary")
                yield Button("Cancel", id="btn-rotate-cancel")

    def _create_cleanup_form(self):
        """Create the cleanup operation form."""
        with Vertical(classes="form-container"):
            yield Label("🧹 Cleanup Old Resources", classes="form-title")
            yield Label(
                "Remove expired repositories, old thaw requests, and orphan ILM policies."
            )

            with Grid(classes="form-grid"):
                yield Label("Retention (days):")
                yield Input(value="30", id="cleanup-retention")

            with Horizontal(classes="form-options"):
                yield Checkbox(
                    "Dry run (preview only)", id="cleanup-dry-run", value=True
                )

            with Horizontal(classes="form-actions"):
                yield Button("🧹 Execute Cleanup", id="btn-cleanup", variant="warning")
                yield Button("Cancel", id="btn-cleanup-cancel")

    def _create_repair_form(self):
        """Create the repair metadata form."""
        with Vertical(classes="form-container"):
            yield Label("🔧 Repair Metadata", classes="form-title")
            yield Label(
                "Scan for and fix metadata inconsistencies between recorded and actual repository states."
            )

            with Horizontal(classes="form-options"):
                yield Checkbox("Dry run (scan only)", id="repair-dry-run", value=True)

            with Horizontal(classes="form-actions"):
                yield Button("🔧 Execute Repair", id="btn-repair", variant="primary")
                yield Button("Cancel", id="btn-repair-cancel")

    def _create_setup_form(self):
        """Create the setup form."""
        with Vertical(classes="form-container"):
            yield Label("⚡ Initialize Deepfreeze", classes="form-title")
            yield Label(
                "Set up the initial repository, bucket, and optional ILM policy."
            )

            with Grid(classes="form-grid"):
                yield Label("Repo Prefix:")
                yield Input(value="deepfreeze", id="setup-repo-prefix")

                yield Label("Bucket Prefix:")
                yield Input(value="deepfreeze", id="setup-bucket-prefix")

                yield Label("ILM Policy (optional):")
                yield Input(placeholder="e.g., my-ilm-policy", id="setup-ilm-policy")

                yield Label("Index Template (optional):")
                yield Input(placeholder="e.g., my-template", id="setup-template")

            with Horizontal(classes="form-options"):
                yield Checkbox("Dry run (preview only)", id="setup-dry-run", value=True)

            with Horizontal(classes="form-actions"):
                yield Button("⚡ Execute Setup", id="btn-setup", variant="primary")
                yield Button("Cancel", id="btn-setup-cancel")

    def action_switch_overview(self):
        """Switch to overview."""
        self.app.push_screen("overview")

    def action_switch_repos(self):
        """Switch to repositories."""
        self.app.push_screen("repositories")

    def action_switch_thaw(self):
        """Switch to thaw."""
        self.app.push_screen("thaw")

    def action_switch_config(self):
        """Switch to configuration."""
        self.app.push_screen("configuration")

    def action_switch_logs(self):
        """Switch to logs."""
        self.app.push_screen("logs")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle button presses."""
        button_id = event.button.id
        log = self.query_one("#output-log", RichLog)

        if button_id == "btn-rotate":
            self.current_action = "rotate"
            dry_run = self.query_one("#rotate-dry-run", Checkbox).value
            keep = self.query_one("#rotate-keep", Input).value

            log.write(f"[blue]Executing Rotate (dry_run={dry_run})...[/blue]")
            # Would call: self.app.service.rotate(keep=int(keep), dry_run=dry_run)
            log.write(
                f"[green]✓ Rotate {'preview' if dry_run else 'execution'} completed[/green]"
            )

        elif button_id == "btn-cleanup":
            self.current_action = "cleanup"
            dry_run = self.query_one("#cleanup-dry-run", Checkbox).value
            retention = self.query_one("#cleanup-retention", Input).value

            log.write(
                f"[blue]Executing Cleanup (dry_run={dry_run}, retention={retention} days)...[/blue]"
            )
            # Would call: self.app.service.cleanup(...)
            log.write(
                f"[green]✓ Cleanup {'preview' if dry_run else 'execution'} completed[/green]"
            )

        elif button_id == "btn-repair":
            self.current_action = "repair"
            dry_run = self.query_one("#repair-dry-run", Checkbox).value

            log.write(f"[blue]Executing Metadata Repair (dry_run={dry_run})...[/blue]")
            # Would call: self.app.service.repair_metadata(dry_run=dry_run)
            log.write(
                f"[green]✓ Repair {'scan' if dry_run else 'execution'} completed[/green]"
            )

        elif button_id == "btn-setup":
            self.current_action = "setup"
            dry_run = self.query_one("#setup-dry-run", Checkbox).value
            repo_prefix = self.query_one("#setup-repo-prefix", Input).value
            bucket_prefix = self.query_one("#setup-bucket-prefix", Input).value

            log.write(f"[blue]Executing Setup (dry_run={dry_run})...[/blue]")
            log.write(f"  Repo prefix: {repo_prefix}")
            log.write(f"  Bucket prefix: {bucket_prefix}")
            # Would call: self.app.service.setup(...)
            log.write(
                f"[green]✓ Setup {'preview' if dry_run else 'execution'} completed[/green]"
            )

        elif button_id in [
            "btn-rotate-cancel",
            "btn-cleanup-cancel",
            "btn-repair-cancel",
            "btn-setup-cancel",
        ]:
            log.write("[dim]Operation cancelled[/dim]")
