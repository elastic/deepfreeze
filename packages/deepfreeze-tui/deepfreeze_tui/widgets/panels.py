"""Panel widgets for the lazygit-style deepfreeze TUI."""

from typing import Any

from textual.containers import Vertical, VerticalScroll
from textual.widgets import OptionList, Static
from textual.widgets.option_list import Option


# -- State color mapping --
STATE_COLORS = {
    "active": "green",
    "frozen": "cyan",
    "thawing": "yellow",
    "thawed": "magenta",
    "expired": "red",
}

THAW_STATUS_COLORS = {
    "in_progress": "yellow",
    "completed": "green",
    "failed": "red",
    "refrozen": "cyan",
}


def _trim_date(val) -> str:
    """Trim a date/datetime value to Y-m-dTH:M format (no seconds/millis)."""
    if not val:
        return ""
    s = str(val)
    for suffix in ("Z", "+00:00"):
        s = s.removesuffix(suffix)
    # Trim to YYYY-MM-DDTHH:MM (16 chars)
    if len(s) > 16:
        s = s[:16]
    return s


class RepoPanel(OptionList):
    """Repository list panel."""

    BINDINGS = [
        ("r", "rotate", "Rotate"),
        ("t", "thaw", "Thaw"),
        ("c", "cleanup", "Cleanup"),
        ("f", "repair", "Fix"),
    ]

    can_focus = True

    def __init__(self, **kwargs):
        super().__init__(id="repos", classes="panel", **kwargs)
        self._repos: list[dict[str, Any]] = []

    def on_mount(self) -> None:
        self.border_title = "Repositories"
        self.border_subtitle = "\\[r]otate \\[t]haw \\[c]leanup \\[f]ix"

    def update_repos(self, repos: list[dict[str, Any]]) -> None:
        """Replace all repos in the list, sorted by name."""
        self._repos = sorted(repos, key=lambda r: r.get("name", ""))
        self.clear_options()
        for repo in self._repos:
            name = repo.get("name", "?")
            state = repo.get("thaw_state", "?")
            mounted = "M" if repo.get("is_mounted") else " "
            color = STATE_COLORS.get(state, "white")
            self.add_option(
                Option(f"{mounted} {name}  [{color}]{state}[/{color}]", id=name)
            )

    def get_selected_repo(self) -> dict[str, Any] | None:
        """Get the currently highlighted repo data."""
        if self.highlighted is not None and self.highlighted < len(self._repos):
            return self._repos[self.highlighted]
        return None

    def action_rotate(self) -> None:
        self.app.action_do_rotate()

    def action_thaw(self) -> None:
        self.app.action_do_thaw()

    def action_cleanup(self) -> None:
        self.app.action_do_cleanup()

    def action_repair(self) -> None:
        self.app.action_do_repair()


class ThawPanel(OptionList):
    """Thaw request list panel."""

    BINDINGS = [
        ("f", "refreeze", "Refreeze"),
    ]

    can_focus = True

    def __init__(self, **kwargs):
        super().__init__(id="thaw-requests", classes="panel", **kwargs)
        self._requests: list[dict[str, Any]] = []

    def on_mount(self) -> None:
        self.border_title = "Thaw Requests"
        self.border_subtitle = "\\[f]reeze"

    def update_requests(self, requests: list[dict[str, Any]]) -> None:
        """Replace all thaw requests."""
        self._requests = sorted(
            requests, key=lambda r: r.get("created_at", r.get("id", "")), reverse=True
        )
        self.clear_options()
        for req in self._requests:
            req_id = req.get("id", req.get("request_id", "?"))
            status = req.get("status", "?")
            color = THAW_STATUS_COLORS.get(status, "white")
            # Show short ID
            short_id = req_id[-8:] if len(req_id) > 8 else req_id
            repos = req.get("repos", [])
            repo_count = len(repos) if isinstance(repos, list) else "?"
            self.add_option(
                Option(
                    f"{short_id}  [{color}]{status:<14}[/{color}] {repo_count} repos",
                    id=req_id,
                )
            )

    def get_selected_request(self) -> dict[str, Any] | None:
        """Get the currently highlighted thaw request data."""
        if self.highlighted is not None and self.highlighted < len(self._requests):
            return self._requests[self.highlighted]
        return None

    def action_refreeze(self) -> None:
        self.app.action_do_refreeze()


class BucketPanel(OptionList):
    """Storage bucket list panel."""

    can_focus = True

    def __init__(self, **kwargs):
        super().__init__(id="buckets", classes="panel", **kwargs)
        self._buckets: list[dict[str, Any]] = []

    def on_mount(self) -> None:
        self.border_title = "Buckets"

    def update_buckets(self, buckets: list[dict[str, Any]]) -> None:
        """Replace all buckets."""
        self._buckets = buckets
        self.clear_options()
        for bucket in buckets:
            name = bucket.get("name", "?")
            count = bucket.get("object_count", "?")
            self.add_option(Option(f"{name:<30} {count} objects", id=name))

    def get_selected_bucket(self) -> dict[str, Any] | None:
        """Get the currently highlighted bucket data."""
        if self.highlighted is not None and self.highlighted < len(self._buckets):
            return self._buckets[self.highlighted]
        return None


class ILMPanel(OptionList):
    """ILM policy list panel."""

    can_focus = True

    def __init__(self, **kwargs):
        super().__init__(id="ilm-policies", classes="panel", **kwargs)
        self._policies: list[dict[str, Any]] = []

    def on_mount(self) -> None:
        self.border_title = "ILM Policies"

    def update_policies(self, policies: list[dict[str, Any]]) -> None:
        """Replace all ILM policies."""
        self._policies = policies
        self.clear_options()
        for policy in policies:
            name = policy.get("name", "?")
            repo = policy.get("repository", "?")
            indices = policy.get("indices_count", 0)
            self.add_option(Option(f"{name:<25} {repo:<20} {indices} idx", id=name))

    def get_selected_policy(self) -> dict[str, Any] | None:
        """Get the currently highlighted ILM policy data."""
        if self.highlighted is not None and self.highlighted < len(self._policies):
            return self._policies[self.highlighted]
        return None


class DetailPanel(Vertical):
    """Right-side detail panel with tabbed views, like lazygit.

    When repos panel is focused, shows two tabs in the border title:
      [Selected] - All Repos
    Switching tabs toggles between single-repo detail and all-repos list.
    Other panel contexts (thaw, bucket, ilm) show their own detail.
    """

    BINDINGS = [
        ("left_square_bracket", "prev_tab", "Prev tab"),
        ("right_square_bracket", "next_tab", "Next tab"),
    ]

    can_focus = True

    TAB_SELECTED = 0
    TAB_ALL_REPOS = 1
    TAB_NAMES = ["Selected", "All Repos"]

    def __init__(self, **kwargs):
        super().__init__(id="detail-panel", classes="panel", **kwargs)
        self._active_tab = self.TAB_SELECTED
        self._all_repos: list[dict[str, Any]] = []
        self._panel_context = "repos"
        self._populating = False  # guard against events during data load
        self._last_detail_text = ""  # track current detail content for appending

    def compose(self):
        # Tab 0: Selected item detail (scrollable)
        yield VerticalScroll(
            Static(
                "[dim]Select an item to view details[/dim]",
                id="detail-content",
            ),
            id="detail-selected",
        )
        # Tab 1: All repos columnar view (scrollable)
        yield VerticalScroll(
            Static("[dim]Loading...[/dim]", id="all-repos-content"),
            id="detail-all-repos",
        )

    def on_mount(self) -> None:
        self._update_title()
        self._show_active_tab()

    def _update_title(self) -> None:
        """Update border title to show tabs like lazygit."""
        if self._panel_context == "repos":
            parts = []
            for i, name in enumerate(self.TAB_NAMES):
                if i == self._active_tab:
                    parts.append(f"[bold green]{name}[/bold green]")
                else:
                    parts.append(f"[dim]{name}[/dim]")
            self.border_title = " - ".join(parts)
        else:
            self.border_title = "Detail"

    def _show_active_tab(self) -> None:
        """Show only the active tab's widget."""
        selected = self.query_one("#detail-selected")
        all_repos = self.query_one("#detail-all-repos")
        if self._panel_context == "repos" and self._active_tab == self.TAB_ALL_REPOS:
            selected.styles.display = "none"
            all_repos.styles.display = "block"
        else:
            selected.styles.display = "block"
            all_repos.styles.display = "none"

    def set_context(self, context: str) -> None:
        """Set which left panel is active. Resets to Selected tab for non-repos."""
        self._panel_context = context
        if context != "repos":
            self._active_tab = self.TAB_SELECTED
        self._update_title()
        self._show_active_tab()

    def action_next_tab(self) -> None:
        if self._panel_context == "repos":
            self._active_tab = (self._active_tab + 1) % len(self.TAB_NAMES)
            self._update_title()
            self._show_active_tab()

    def action_prev_tab(self) -> None:
        if self._panel_context == "repos":
            self._active_tab = (self._active_tab - 1) % len(self.TAB_NAMES)
            self._update_title()
            self._show_active_tab()

    def switch_to_selected(self) -> None:
        """Switch to the Selected tab."""
        self._active_tab = self.TAB_SELECTED
        self._update_title()
        self._show_active_tab()

    def show_all_repos_tab(self) -> None:
        """Switch to the All Repos tab."""
        self._active_tab = self.TAB_ALL_REPOS
        self._update_title()
        self._show_active_tab()

    def update_all_repos(self, repos: list[dict[str, Any]]) -> None:
        """Populate the All Repos tab with a columnar table view."""
        self._populating = True
        try:
            self._all_repos = sorted(repos, key=lambda r: r.get("name", ""))
            content = self.query_one("#all-repos-content", Static)

            if not self._all_repos:
                content.update("[dim]No repositories found[/dim]")
                return

            # Column header
            lines = [
                "[bold]"
                f"{'Name':<16} {'Base Path':<18} "
                f"{'Start':<17} {'End':<17} {'M':>1} {'State':<8} {'Storage Tier':<12}"
                "[/bold]",
                "[dim]" + "─" * 93 + "[/dim]",
            ]

            tier_colors = {
                "Archive": "blue",
                "Hot": "green",
                "Cool": "cyan",
                "Mixed": "yellow",
                "Empty": "dim",
                "N/A": "dim",
            }

            for repo in self._all_repos:
                name = repo.get("name", "?")
                base_path = repo.get("base_path", "N/A")
                start = _trim_date(repo.get("start", ""))
                end = _trim_date(repo.get("end", ""))
                mounted = (
                    "[green]Y[/green]" if repo.get("is_mounted") else "[red]N[/red]"
                )
                state = repo.get("thaw_state", "?")
                state_color = STATE_COLORS.get(state, "white")
                tier = repo.get("storage_tier", "N/A")
                tier_color = tier_colors.get(tier, "white")

                lines.append(
                    f"{name:<16} {base_path:<18} "
                    f"{start:<17} {end:<17} {mounted:>1} "
                    f"[{state_color}]{state:<8}[/{state_color}] "
                    f"[{tier_color}]{tier:<12}[/{tier_color}]"
                )

            content.update("\n".join(lines))
        finally:
            self._populating = False

    def _set_detail_content(self, text: str) -> None:
        """Set the detail content and track it for appending."""
        self._last_detail_text = text
        self.query_one("#detail-content", Static).update(text)

    # -- Show methods (always update the Selected tab content) --

    def show_repo_detail(self, repo: dict[str, Any]) -> None:
        """Display repository details and switch to Selected tab."""
        content = self.query_one("#detail-content", Static)
        name = repo.get("name", "?")
        state = repo.get("thaw_state", "?")
        color = STATE_COLORS.get(state, "white")
        mounted = "Yes" if repo.get("is_mounted") else "No"
        bucket = repo.get("bucket", "?")
        base_path = repo.get("base_path", "?")
        tier = repo.get("storage_tier", "?")
        start = _trim_date(repo.get("start", ""))
        end = _trim_date(repo.get("end", ""))
        thawed_at = _trim_date(repo.get("thawed_at", ""))
        expires_at = _trim_date(repo.get("expires_at", ""))

        lines = [
            f"[bold]Repository:[/bold] {name}",
            "",
            f"  State:        [{color}]{state}[/{color}]",
            f"  Mounted:      {mounted}",
            f"  Bucket:       {bucket}",
            f"  Base Path:    {base_path}",
            f"  Storage Tier: {tier}",
            f"  Date Range:   {start or '?'} .. {end or '?'}",
        ]
        if thawed_at:
            lines.append(f"  Thawed At:    {thawed_at}")
        if expires_at:
            lines.append(f"  Expires At:   {expires_at}")

        content.update("\n".join(lines))
        self.switch_to_selected()

    def show_thaw_detail(self, req: dict[str, Any]) -> None:
        """Display thaw request details."""
        req_id = req.get("id", req.get("request_id", "?"))
        status = req.get("status", "?")
        color = THAW_STATUS_COLORS.get(status, "white")
        repos = req.get("repos", [])
        created = _trim_date(req.get("created_at", "")) or "?"
        start_date = _trim_date(req.get("start_date", "")) or "?"
        end_date = _trim_date(req.get("end_date", "")) or "?"
        age = req.get("age_days", "?")

        elapsed = ""
        try:
            from datetime import datetime, timezone
            created_raw = req.get("created_at", "")
            if created_raw:
                created_dt = datetime.fromisoformat(str(created_raw))
                if created_dt.tzinfo is None:
                    created_dt = created_dt.replace(tzinfo=timezone.utc)
                delta = datetime.now(timezone.utc) - created_dt
                total_secs = int(delta.total_seconds())
                if total_secs >= 0:
                    h, rem = divmod(total_secs, 3600)
                    m, s = divmod(rem, 60)
                    elapsed = f" [dim]({h:02d}:{m:02d}:{s:02d} ago)[/dim]"
        except Exception:
            pass

        lines = [
            f"[bold]Thaw Request:[/bold] {req_id}",
            "",
            f"  Status:     [{color}]{status}[/{color}]",
            f"  Created:    {created}{elapsed}",
            f"  Date Range: {start_date} .. {end_date}",
            f"  Age:        {age} days",
            "",
            f"  Repositories ({len(repos)}):",
        ]
        for r in repos:
            if isinstance(r, str):
                lines.append(f"    - {r}")
            elif isinstance(r, dict):
                lines.append(f"    - {r.get('name', r)}")

        self._set_detail_content("\n".join(lines))

    def append_restore_progress(self, progress: list[dict[str, Any]]) -> None:
        """Append S3 restore progress to the current detail view."""
        lines = ["", "[bold]S3 Restore Progress[/bold]", ""]
        for rp in progress:
            name = rp.get("repo", "?")
            total = rp.get("total", 0)
            restored = rp.get("restored", 0)
            in_prog = rp.get("in_progress", 0)
            not_restored = rp.get("not_restored", 0)
            complete = rp.get("complete", False)
            error = rp.get("error")

            if error:
                lines.append(f"  {name}: [red]{error}[/red]")
                continue

            pct = round((restored / total) * 100) if total > 0 else 0
            color = "green" if complete else "yellow"
            bar_width = 20
            filled = round(bar_width * pct / 100)
            bar = f"[{color}]{'█' * filled}[/{color}]{'░' * (bar_width - filled)}"

            lines.append(f"  {name}")
            lines.append(f"    {bar} {pct}%")
            lines.append(
                f"    [dim]total:{total}  restored:{restored}  "
                f"in_progress:{in_prog}  pending:{not_restored}[/dim]"
            )

        full_text = self._last_detail_text + "\n".join(lines)
        self._set_detail_content(full_text)

    def show_bucket_detail(self, bucket: dict[str, Any]) -> None:
        """Display bucket details."""
        content = self.query_one("#detail-content", Static)
        name = bucket.get("name", "?")
        count = bucket.get("object_count", "?")

        lines = [
            f"[bold]Bucket:[/bold] {name}",
            "",
            f"  Object Count: {count}",
        ]
        content.update("\n".join(lines))

    def show_ilm_detail(self, policy: dict[str, Any]) -> None:
        """Display ILM policy details."""
        content = self.query_one("#detail-content", Static)
        name = policy.get("name", "?")
        repo = policy.get("repository", "?")
        indices = policy.get("indices_count", 0)
        data_streams = policy.get("data_streams_count", 0)
        templates = policy.get("templates_count", 0)

        lines = [
            f"[bold]ILM Policy:[/bold] {name}",
            "",
            f"  Repository:    {repo}",
            f"  Indices:       {indices}",
            f"  Data Streams:  {data_streams}",
            f"  Templates:     {templates}",
        ]
        content.update("\n".join(lines))

    def show_status_summary(self, status_data: dict[str, Any]) -> None:
        """Display a system status summary."""
        content = self.query_one("#detail-content", Static)
        cluster = status_data.get("cluster", {})
        repos = status_data.get("repositories", [])
        thaw_reqs = status_data.get("thaw_requests", [])
        buckets = status_data.get("buckets", [])
        ilm = status_data.get("ilm_policies", [])
        errors = status_data.get("errors", [])

        state_counts = {}
        for r in repos:
            s = r.get("thaw_state", "unknown")
            state_counts[s] = state_counts.get(s, 0) + 1

        cluster_name = cluster.get("name", "?") if isinstance(cluster, dict) else "?"
        cluster_status = (
            cluster.get("status", "?") if isinstance(cluster, dict) else "?"
        )
        cluster_version = (
            cluster.get("version", "?") if isinstance(cluster, dict) else "?"
        )
        nodes = cluster.get("node_count", "?") if isinstance(cluster, dict) else "?"

        lines = [
            "[bold]System Status[/bold]",
            "",
            f"  Cluster:  {cluster_name}",
            f"  Health:   {cluster_status}",
            f"  Version:  {cluster_version}",
            f"  Nodes:    {nodes}",
            "",
            f"  Repositories: {len(repos)}",
        ]
        for state, count in sorted(state_counts.items()):
            color = STATE_COLORS.get(state, "white")
            lines.append(f"    [{color}]{state:<10}[/{color}] {count}")

        lines.extend(
            [
                "",
                f"  Thaw Requests: {len(thaw_reqs)}",
                f"  Buckets:       {len(buckets)}",
                f"  ILM Policies:  {len(ilm)}",
            ]
        )

        if errors:
            lines.extend(["", "[bold red]Errors:[/bold red]"])
            for err in errors:
                msg = (
                    err.get("message", str(err)) if isinstance(err, dict) else str(err)
                )
                lines.append(f"  [red]- {msg}[/red]")

        content.update("\n".join(lines))


class ConfigPanel(Static):
    """Collapsible configuration panel.

    When focused, expands to show full config details.
    When not focused, collapses to a single-line summary.
    """

    can_focus = True

    def __init__(self, **kwargs):
        super().__init__("", id="config-panel", classes="panel", **kwargs)
        self._config: dict[str, Any] = {}
        self._expanded = False

    def on_mount(self) -> None:
        self.border_title = "Config"

    def update_config(self, settings: dict[str, Any] | None) -> None:
        """Update the config data."""
        self._config = settings or {}
        self._render_config()

    def on_focus(self) -> None:
        self._expanded = True
        self._render_config()

    def on_blur(self) -> None:
        self._expanded = False
        self._render_config()

    def _render_config(self) -> None:
        if not self._config:
            self.update("[dim]No config loaded[/dim]")
            return

        if not self._expanded:
            # Collapsed: single-line summary
            provider = self._config.get("provider", "?")
            prefix = self._config.get("repo_name_prefix", "?")
            style = self._config.get("style", "?")
            self.update(
                f"[dim]provider:[/dim]{provider}  "
                f"[dim]prefix:[/dim]{prefix}  "
                f"[dim]style:[/dim]{style}"
            )
            return

        # Expanded: full config
        lines = []
        fields = [
            ("Provider", "provider"),
            ("Repo Prefix", "repo_name_prefix"),
            ("Bucket Prefix", "bucket_name_prefix"),
            ("Base Path Prefix", "base_path_prefix"),
            ("Storage Class", "storage_class"),
            ("Canned ACL", "canned_acl"),
            ("Rotation Style", "style"),
            ("Rotate By", "rotate_by"),
            ("Last Suffix", "last_suffix"),
            ("ILM Policy", "ilm_policy_name"),
            ("Index Template", "index_template_name"),
            ("Thaw Retention (completed)", "thaw_request_retention_days_completed"),
            ("Thaw Retention (failed)", "thaw_request_retention_days_failed"),
            ("Thaw Retention (refrozen)", "thaw_request_retention_days_refrozen"),
        ]
        for label, key in fields:
            val = self._config.get(key)
            if val is not None:
                lines.append(f" [dim]{label + ':':<30}[/dim] {val}")

        self.update("\n".join(lines))


class ActivityPanel(VerticalScroll):
    """Activity panel showing audit log entries from Elasticsearch.

    Displays recent actions with timestamp, status, action name, and summary.
    Also shows in-session commands as they happen.
    """

    can_focus = True

    def __init__(self, **kwargs):
        super().__init__(id="activity-panel", classes="panel", **kwargs)
        self._pending: list[str] = []

    def compose(self):
        yield Static("[dim]Loading activity...[/dim]", id="activity-content")

    def on_mount(self) -> None:
        self.border_title = "Activity"

    def update_history(self, entries: list[dict[str, Any]]) -> None:
        """Update with audit log entries from the service."""
        lines = []
        for e in entries:
            ts = _trim_date(e.get("timestamp", ""))
            action = e.get("action", "?")
            success = e.get("success", False)
            dry_run = e.get("dry_run", False)
            summary = e.get("summary", "")
            errors = e.get("error_count", 0)

            status = "[green]OK[/green]" if success else "[red]FAIL[/red]"
            line = f"[dim]{ts}[/dim] {status} [bold]{action}[/bold]"
            if dry_run:
                line += " [yellow](dry)[/yellow]"
            if summary:
                safe = str(summary).replace("[", "\\[").replace("]", "\\]")
                line += f" {safe}"
            if errors and errors > 0:
                line += f" [red]({errors} errors)[/red]"
            lines.append(line)

        # Append any pending in-session entries
        if self._pending:
            if lines:
                lines.append("[dim]───[/dim]")
            lines.extend(self._pending)

        content = self.query_one("#activity-content", Static)
        if lines:
            content.update("\n".join(lines))
        else:
            content.update("[dim]No activity yet[/dim]")

    def log_command(self, action: str, detail: str = "") -> None:
        """Log an in-session command (shows immediately before next audit refresh)."""
        from datetime import datetime

        ts = datetime.now().strftime("%H:%M:%S")
        entry = f"[dim]{ts}[/dim] [cyan]...[/cyan] [bold]{action}[/bold]"
        if detail:
            safe = detail.replace("[", "\\[").replace("]", "\\]")
            entry += f" {safe}"
        self._pending.append(entry)
        self._append_to_display(entry)

    def log_result(
        self, action: str, success: bool, summary: str, duration_ms: int = 0
    ) -> None:
        """Log a completed command result."""
        from datetime import datetime

        ts = datetime.now().strftime("%H:%M:%S")
        status = "[green]OK[/green]" if success else "[red]FAIL[/red]"
        safe_summary = summary.replace("[", "\\[").replace("]", "\\]")
        entry = f"[dim]{ts}[/dim] {status} [bold]{action}[/bold] {safe_summary}"
        if duration_ms > 0:
            entry += f" [dim]({duration_ms}ms)[/dim]"
        self._pending.append(entry)
        self._append_to_display(entry)

    def _append_to_display(self, entry: str) -> None:
        """Append a single entry to current display."""
        content = self.query_one("#activity-content", Static)
        current = content.renderable
        if current and str(current) != "[dim]Loading activity...[/dim]" and str(current) != "[dim]No activity yet[/dim]":
            content.update(f"{current}\n{entry}")
        else:
            content.update(entry)
        self.scroll_end(animate=False)
