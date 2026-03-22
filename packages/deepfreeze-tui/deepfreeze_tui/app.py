"""Main Textual app for deepfreeze TUI - lazygit style."""

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Static, OptionList

from deepfreeze_service import DeepfreezeService, PollingConfig

from .dialogs import ThawDialog
from .modals import HelpPanel
from .widgets.panels import (
    BucketPanel,
    DetailPanel,
    ILMPanel,
    RepoPanel,
    ThawPanel,
)


class DeepfreezeApp(App):
    """Lazygit-style TUI for deepfreeze."""

    CSS_PATH = "styles/theme.tcss"
    TITLE = "deepfreeze"

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("question_mark", "show_help", "Help", key_display="?"),
        Binding("ctrl+r", "refresh", "Refresh"),
        Binding("1", "focus_panel('repos')", "Repos", show=False),
        Binding("2", "focus_panel('thaw-requests')", "Thaw", show=False),
        Binding("3", "focus_panel('buckets')", "Buckets", show=False),
        Binding("4", "focus_panel('ilm-policies')", "ILM", show=False),
        Binding("5", "focus_panel('detail-scroll')", "Detail", show=False),
    ]

    def __init__(self, config_path=None, refresh_interval=30):
        super().__init__()
        self.config_path = config_path
        self.refresh_interval = refresh_interval
        self.service: DeepfreezeService | None = None
        self._status_data: dict = {}

    def compose(self) -> ComposeResult:
        """Compose the lazygit-style layout."""
        # Status bar
        yield Static(
            "[bold]deepfreeze[/bold]  [dim]connecting...[/dim]",
            id="status-bar",
        )

        with Horizontal(id="main"):
            # Left column: stacked list panels
            with Vertical(id="left-col"):
                yield RepoPanel()
                yield ThawPanel()
                yield BucketPanel()
                yield ILMPanel()

            # Right column: detail view
            with Vertical(id="right-col"):
                yield DetailPanel()

        yield Footer()

        # Overlay panels - float over layout when toggled visible
        yield HelpPanel()
        yield ThawDialog()

    def on_mount(self) -> None:
        """Initialize service and start data loading."""
        self._init_service()
        # Focus repos panel on startup
        self.query_one("#repos").focus()
        # Load initial data
        self.run_worker(self._load_data())
        # Start auto-refresh
        if self.refresh_interval > 0:
            self.set_interval(self.refresh_interval, self._load_data)

    def _init_service(self) -> None:
        """Initialize the deepfreeze service."""
        try:
            self.service = DeepfreezeService(
                config_path=self.config_path,
                polling_config=PollingConfig(
                    enabled=True,
                    interval_seconds=self.refresh_interval,
                ),
            )
        except Exception as e:
            self._update_status_bar(error=str(e))

    async def _load_data(self) -> None:
        """Fetch status data and populate all panels."""
        if not self.service:
            return

        try:
            status = await self.service.get_status(force_refresh=True)
            self._status_data = status.model_dump()

            # Update all panels
            repos = self._status_data.get("repositories", [])
            thaw_reqs = self._status_data.get("thaw_requests", [])
            buckets = self._status_data.get("buckets", [])
            ilm = self._status_data.get("ilm_policies", [])

            self.query_one(RepoPanel).update_repos(repos)
            self.query_one(ThawPanel).update_requests(thaw_reqs)
            self.query_one(BucketPanel).update_buckets(buckets)
            self.query_one(ILMPanel).update_policies(ilm)

            # Update status bar
            cluster = self._status_data.get("cluster", {})
            cluster_name = (
                cluster.get("name", "?") if isinstance(cluster, dict) else "?"
            )
            health = cluster.get("status", "?") if isinstance(cluster, dict) else "?"
            health_color = {"green": "green", "yellow": "yellow", "red": "red"}.get(
                health, "dim"
            )
            errors = self._status_data.get("errors", [])

            status_text = (
                f"[bold]deepfreeze[/bold]  "
                f"cluster:[{health_color}]{cluster_name}[/{health_color}]  "
                f"repos:{len(repos)}  thaw:{len(thaw_reqs)}  "
                f"buckets:{len(buckets)}  ilm:{len(ilm)}"
            )
            if errors:
                status_text += f"  [red]errors:{len(errors)}[/red]"

            self._update_status_bar(text=status_text)

            # Show system summary in detail panel if nothing selected yet
            detail = self.query_one(DetailPanel)
            detail.show_status_summary(self._status_data)

        except Exception as e:
            self._update_status_bar(error=str(e))

    def _update_status_bar(self, text: str = None, error: str = None) -> None:
        """Update the status bar."""
        bar = self.query_one("#status-bar", Static)
        if error:
            safe = error.replace("[", "\\[").replace("]", "\\]")
            bar.update(f"[bold]deepfreeze[/bold]  [red]{safe}[/red]")
        elif text:
            bar.update(text)

    # -- Selection handlers: update detail panel --

    def on_option_list_option_highlighted(
        self, event: OptionList.OptionHighlighted
    ) -> None:
        """Update detail panel when user navigates lists."""
        source_id = event.option_list.id
        detail = self.query_one(DetailPanel)

        if source_id == "repos":
            repo = self.query_one(RepoPanel).get_selected_repo()
            if repo:
                detail.show_repo_detail(repo)
        elif source_id == "thaw-requests":
            req = self.query_one(ThawPanel).get_selected_request()
            if req:
                detail.show_thaw_detail(req)
        elif source_id == "buckets":
            bucket = self.query_one(BucketPanel).get_selected_bucket()
            if bucket:
                detail.show_bucket_detail(bucket)
        elif source_id == "ilm-policies":
            policy = self.query_one(ILMPanel).get_selected_policy()
            if policy:
                detail.show_ilm_detail(policy)

    # -- Actions (keybinding targets) --

    def action_focus_panel(self, panel_id: str) -> None:
        """Focus a specific panel by ID."""
        try:
            self.query_one(f"#{panel_id}").focus()
        except Exception:
            pass

    def action_refresh(self) -> None:
        """Manual refresh."""
        self.run_worker(self._load_data())
        self.notify("Refreshing...", timeout=2)

    def action_show_help(self) -> None:
        """Toggle context-sensitive help panel."""
        focused = self.focused
        focused_id = ""
        if focused is not None:
            focused_id = focused.id or ""
        self.query_one(HelpPanel).toggle(focused_panel_id=focused_id)

    # -- Real action implementations --

    def action_do_rotate(self) -> None:
        """Execute rotate action."""
        if not self.service:
            self.notify("Service not initialized", severity="error")
            return
        self.notify("Running rotate...", timeout=3)
        self.run_worker(self._exec_rotate())

    async def _exec_rotate(self) -> None:
        result = await self.service.rotate()
        self._show_result("Rotate", result)

    def action_do_thaw(self) -> None:
        """Prompt for thaw parameters and execute."""
        if not self.service:
            self.notify("Service not initialized", severity="error")
            return
        self.query_one(ThawDialog).show(callback=self._handle_thaw_input)

    def _handle_thaw_input(self, params: dict) -> None:
        """Handle thaw dialog result."""
        if not self.service:
            return
        self.notify("Creating thaw request...", timeout=3)
        self.run_worker(self._exec_thaw(params))

    async def _exec_thaw(self, params: dict) -> None:
        from datetime import datetime

        start = datetime.fromisoformat(params["start_date"])
        end = datetime.fromisoformat(params["end_date"])
        duration = params.get("duration", 7)
        result = await self.service.thaw_create(
            start_date=start,
            end_date=end,
            duration=duration,
        )
        self._show_result("Thaw", result)

    def action_do_cleanup(self) -> None:
        """Execute cleanup action."""
        if not self.service:
            self.notify("Service not initialized", severity="error")
            return
        self.notify("Running cleanup...", timeout=3)
        self.run_worker(self._exec_cleanup())

    async def _exec_cleanup(self) -> None:
        result = await self.service.cleanup()
        self._show_result("Cleanup", result)

    def action_do_repair(self) -> None:
        """Execute repair metadata action."""
        if not self.service:
            self.notify("Service not initialized", severity="error")
            return
        self.notify("Running metadata repair...", timeout=3)
        self.run_worker(self._exec_repair())

    async def _exec_repair(self) -> None:
        result = await self.service.repair_metadata()
        self._show_result("Repair", result)

    def action_do_refreeze(self) -> None:
        """Refreeze the selected thaw request."""
        if not self.service:
            self.notify("Service not initialized", severity="error")
            return
        # Get selected thaw request
        req = self.query_one(ThawPanel).get_selected_request()
        if not req:
            self.notify("No thaw request selected", severity="warning")
            return
        req_id = req.get("id", req.get("request_id"))
        if not req_id:
            self.notify("Could not determine request ID", severity="error")
            return
        self.notify(f"Refreezing {req_id[-8:]}...", timeout=3)
        self.run_worker(self._exec_refreeze(req_id))

    async def _exec_refreeze(self, request_id: str) -> None:
        result = await self.service.refreeze(request_id=request_id)
        self._show_result("Refreeze", result)

    def _show_result(self, action_name: str, result) -> None:
        """Display action result in the detail panel and as notification."""
        detail = self.query_one(DetailPanel)
        content = detail.query_one("#detail-content", Static)

        if result.success:
            severity = "information"
            lines = [
                f"[bold green]{action_name} completed successfully[/bold green]",
                "",
                f"  Duration: {result.duration_ms}ms",
                f"  Summary:  {result.summary}",
            ]
            if result.details:
                lines.extend(["", "  Details:"])
                for d in result.details:
                    target = (
                        d.get("target", "?")
                        if isinstance(d, dict)
                        else getattr(d, "target", "?")
                    )
                    status = (
                        d.get("status", "")
                        if isinstance(d, dict)
                        else getattr(d, "status", "")
                    )
                    lines.append(f"    - {target}: {status}")
        else:
            severity = "error"
            lines = [
                f"[bold red]{action_name} failed[/bold red]",
                "",
                f"  Summary: {result.summary}",
            ]
            if result.errors:
                lines.extend(["", "  Errors:"])
                for e in result.errors:
                    msg = (
                        e.get("message", str(e))
                        if isinstance(e, dict)
                        else getattr(e, "message", str(e))
                    )
                    lines.append(f"    [red]- {msg}[/red]")

        content.update("\n".join(lines))
        # Also notify briefly
        safe_summary = result.summary.replace("[", "\\[").replace("]", "\\]")
        self.notify(f"{action_name}: {safe_summary}", severity=severity, timeout=5)

        # Refresh data after action
        self.run_worker(self._load_data())
