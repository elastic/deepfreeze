"""Repositories screen - Browse and manage repositories."""

from textual.screen import Screen
from textual.containers import Vertical, Horizontal
from textual.widgets import (
    Static,
    Button,
    DataTable,
    Input,
    Label,
    RadioButton,
    RadioSet,
    TabbedContent,
    TabPane,
)
from textual.reactive import reactive


class StateBadge(Static):
    """Badge showing repository state with appropriate color."""

    STATE_COLORS = {
        "active": ("#008a5e", "●"),  # Green
        "frozen": ("#0b64dd", "❄"),  # Blue
        "thawing": ("#facb3d", "⏳"),  # Yellow
        "thawed": ("#008b87", "✓"),  # Teal
        "expired": ("#c61e25", "⚠"),  # Red
    }

    def __init__(self, state: str = "unknown"):
        super().__init__()
        self.state = state.lower()

    def on_mount(self):
        self.update_badge()

    def update_badge(self):
        color, icon = self.STATE_COLORS.get(self.state, ("#7b7b7b", "?"))
        self.update(f"[{color}]{icon} {self.state.upper()}[/{color}]")


class RepositoriesScreen(Screen):
    """Screen for browsing and managing repositories."""

    BINDINGS = [
        ("r", "refresh", "Refresh"),
        ("/", "search", "Search"),
        ("1", "switch_overview", "Overview"),
        ("2", "noop", ""),
        ("3", "switch_thaw", "Thaw"),
        ("d", "detail", "Details"),
        ("t", "thaw_selected", "Thaw"),
        ("f", "refreeze_selected", "Refreeze"),
    ]

    # Reactive data
    repositories = reactive([])
    filtered_repos = reactive([])
    selected_repo = reactive(None)
    state_filter = reactive("all")
    search_query = reactive("")

    def compose(self):
        """Compose the repositories screen."""
        with Vertical():
            # Header
            with Horizontal(classes="header-row"):
                yield Label("Repositories", classes="screen-title")
                yield Label("Showing all repositories", id="filter-status")

            # Filter controls
            with Horizontal(classes="filter-row"):
                yield Input(placeholder="Search repositories...", id="search-input")

                with RadioSet(id="state-filter", classes="state-filters"):
                    yield RadioButton("All", value=True)
                    yield RadioButton("Active")
                    yield RadioButton("Frozen")
                    yield RadioButton("Thawing")
                    yield RadioButton("Thawed")
                    yield RadioButton("Expired")

            # Repository table
            table = DataTable(id="repo-table")
            table.add_columns(
                "State", "Name", "Bucket", "Date Range", "Expires", "Actions"
            )
            table.cursor_type = "row"
            yield table

            # Selected repo details panel
            with Vertical(id="detail-panel", classes="detail-panel"):
                yield Label(
                    "Select a repository to view details", classes="detail-placeholder"
                )

    async def on_mount(self):
        """Called when screen is mounted."""
        await self.load_repositories()

    async def load_repositories(self):
        """Load repository data from service."""
        try:
            if hasattr(self.app, "service") and self.app.service:
                # Show loading state
                status_label = self.query_one("#filter-status", Label)
                status_label.update("Loading repositories...")

                # Fetch real data from service
                status = await self.app.service.get_status()

                # Extract repositories from status
                if hasattr(status, "repositories"):
                    self.repositories = [
                        {
                            "name": repo.name,
                            "state": repo.state,
                            "bucket": repo.bucket,
                            "base_path": repo.base_path,
                            "date_range": f"{repo.date_range_start.strftime('%Y-%m') if repo.date_range_start else '—'} to {repo.date_range_end.strftime('%Y-%m') if repo.date_range_end else '—'}",
                            "expires": repo.expires_at.strftime("%Y-%m-%d")
                            if repo.expires_at
                            else "—",
                        }
                        for repo in status.repositories
                    ]
                else:
                    self.repositories = []

                self.apply_filters()
                status_label.update(f"Showing {len(self.repositories)} repositories")
        except Exception as e:
            self.notify(f"Failed to load repositories: {str(e)}", severity="error")
            self.repositories = []
            self.apply_filters()

    def apply_filters(self):
        """Apply state filter and search query."""
        filtered = self.repositories

        # Apply state filter
        if self.state_filter != "all":
            filtered = [r for r in filtered if r.get("state") == self.state_filter]

        # Apply search query
        if self.search_query:
            query = self.search_query.lower()
            filtered = [r for r in filtered if query in r.get("name", "").lower()]

        self.filtered_repos = filtered
        self.update_table()

        # Update filter status
        status = f"Showing {len(filtered)} of {len(self.repositories)} repositories"
        if self.state_filter != "all":
            status += f" ({self.state_filter})"
        if self.search_query:
            status += f" matching '{self.search_query}'"
        self.query_one("#filter-status", Label).update(status)

    def update_table(self):
        """Update the repository table."""
        table = self.query_one("#repo-table", DataTable)
        table.clear()

        for repo in self.filtered_repos:
            state_badge = StateBadge(repo.get("state", "unknown"))
            actions = self._get_available_actions(repo.get("state"))

            table.add_row(
                state_badge,
                repo.get("name", "—"),
                repo.get("bucket", "—"),
                repo.get("date_range", "—"),
                repo.get("expires", "—"),
                actions,
            )

    def _get_available_actions(self, state: str) -> str:
        """Get available actions for a repository state."""
        actions = {
            "active": "—",
            "frozen": "[T]haw",
            "thawing": "Check…",
            "thawed": "[R]efreeze",
            "expired": "Clean",
        }
        return actions.get(state, "—")

    def on_radio_set_changed(self, event: RadioSet.Changed) -> None:
        """Handle state filter change."""
        selected = event.pressed.label
        self.state_filter = selected.lower() if selected != "All" else "all"
        self.apply_filters()

    def on_input_changed(self, event: Input.Changed) -> None:
        """Handle search input."""
        if event.input.id == "search-input":
            self.search_query = event.value
            self.apply_filters()

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Handle repository selection."""
        if event.row_key and event.row_key.value is not None:
            idx = int(event.row_key.value)
            if idx < len(self.filtered_repos):
                self.selected_repo = self.filtered_repos[idx]
                self.show_repo_details()

    def show_repo_details(self):
        """Show details for selected repository."""
        if not self.selected_repo:
            return

        panel = self.query_one("#detail-panel", Vertical)
        panel.remove_children()

        repo = self.selected_repo
        with panel:
            yield Label(f"Repository: {repo.get('name')}", classes="detail-title")
            yield Label(f"State: {repo.get('state', 'unknown')}")
            yield Label(f"Bucket: {repo.get('bucket')}")
            yield Label(f"Base Path: {repo.get('base_path')}")
            yield Label(f"Date Range: {repo.get('date_range')}")

            # Action buttons based on state
            with Horizontal(classes="detail-actions"):
                state = repo.get("state")
                if state == "frozen":
                    yield Button(
                        "Thaw This Repository", id="btn-thaw-repo", variant="primary"
                    )
                elif state == "thawed":
                    yield Button("Refreeze", id="btn-refreeze-repo", variant="warning")
                yield Button("View Snapshots", id="btn-view-snapshots")

    def action_refresh(self):
        """Refresh repository data."""
        self.run_worker(self.load_repositories())

    async def action_thaw_selected(self):
        """Thaw the selected repository."""
        if self.selected_repo:
            repo_name = self.selected_repo.get("name")
            try:
                if hasattr(self.app, "service") and self.app.service:
                    self.notify(
                        f"Thawing repository {repo_name}...", severity="information"
                    )
                    # Navigate to thaw screen with pre-filled info
                    self.app.push_screen("thaw")
            except Exception as e:
                self.notify(f"Failed to thaw {repo_name}: {str(e)}", severity="error")

    async def action_refreeze_selected(self):
        """Refreeze the selected repository."""
        if self.selected_repo:
            repo_name = self.selected_repo.get("name")
            state = self.selected_repo.get("state")

            if state != "thawed":
                self.notify(
                    f"Repository {repo_name} is not in thawed state (current: {state})",
                    severity="warning",
                )
                return

            try:
                if hasattr(self.app, "service") and self.app.service:
                    self.notify(
                        f"Refreezing repository {repo_name}...", severity="information"
                    )
                    result = await self.app.service.refreeze(
                        request_id=None, dry_run=False
                    )
                    if result.success:
                        self.notify(
                            f"Successfully refrozen {repo_name}", severity="information"
                        )
                        await self.load_repositories()  # Refresh the list
                    else:
                        self.notify(
                            f"Refreeze failed: {result.summary}", severity="error"
                        )
            except Exception as e:
                self.notify(
                    f"Failed to refreeze {repo_name}: {str(e)}", severity="error"
                )

    def action_search(self):
        """Focus search input."""
        self.query_one("#search-input", Input).focus()

    def action_switch_overview(self):
        """Switch to overview."""
        self.app.push_screen("overview")

    def action_switch_thaw(self):
        """Switch to thaw screen."""
        self.app.push_screen("thaw")

    def action_detail(self):
        """Show details for selected repo."""
        table = self.query_one("#repo-table", DataTable)
        if table.cursor_row is not None:
            self.selected_repo = self.filtered_repos[table.cursor_row]
            self.show_repo_details()

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle action buttons."""
        button_id = event.button.id
        if button_id == "btn-thaw-repo":
            await self.action_thaw_selected()
        elif button_id == "btn-refreeze-repo":
            await self.action_refreeze_selected()
        elif button_id == "btn-view-snapshots":
            # Would show snapshots
            self.notify("Snapshot viewing not yet implemented", severity="warning")
