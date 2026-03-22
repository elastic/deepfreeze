"""Panel widgets for the lazygit-style deepfreeze TUI."""

from typing import Any

from textual.containers import VerticalScroll
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
        self.border_subtitle = "[r]otate [t]haw [c]leanup [f]ix"

    def update_repos(self, repos: list[dict[str, Any]]) -> None:
        """Replace all repos in the list."""
        self._repos = repos
        self.clear_options()
        for repo in repos:
            name = repo.get("name", "?")
            state = repo.get("thaw_state", "?")
            mounted = "M" if repo.get("is_mounted") else " "
            color = STATE_COLORS.get(state, "white")
            self.add_option(
                Option(f"{mounted} {name:<30} [{color}]{state}[/{color}]", id=name)
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
        self.border_subtitle = "[f]reeze"

    def update_requests(self, requests: list[dict[str, Any]]) -> None:
        """Replace all thaw requests."""
        self._requests = requests
        self.clear_options()
        for req in requests:
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


class DetailPanel(VerticalScroll):
    """Right-side detail panel showing info about the selected item."""

    can_focus = True

    def __init__(self, **kwargs):
        super().__init__(id="detail-scroll", classes="panel", **kwargs)

    def compose(self):
        yield Static(
            "[dim]Select an item to view details[/dim]",
            id="detail-content",
        )

    def on_mount(self) -> None:
        self.border_title = "Detail"

    def show_repo_detail(self, repo: dict[str, Any]) -> None:
        """Display repository details."""
        content = self.query_one("#detail-content", Static)
        name = repo.get("name", "?")
        state = repo.get("thaw_state", "?")
        color = STATE_COLORS.get(state, "white")
        mounted = "Yes" if repo.get("is_mounted") else "No"
        bucket = repo.get("bucket", "?")
        base_path = repo.get("base_path", "?")
        tier = repo.get("storage_tier", "?")
        start = repo.get("start", "?")
        end = repo.get("end", "?")
        thawed_at = repo.get("thawed_at", None)
        expires_at = repo.get("expires_at", None)

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

    def show_thaw_detail(self, req: dict[str, Any]) -> None:
        """Display thaw request details."""
        content = self.query_one("#detail-content", Static)
        req_id = req.get("id", req.get("request_id", "?"))
        status = req.get("status", "?")
        color = THAW_STATUS_COLORS.get(status, "white")
        repos = req.get("repos", [])
        created = req.get("created_at", "?")
        start_date = req.get("start_date", "?")
        end_date = req.get("end_date", "?")
        age = req.get("age_days", "?")

        lines = [
            f"[bold]Thaw Request:[/bold] {req_id}",
            "",
            f"  Status:     [{color}]{status}[/{color}]",
            f"  Created:    {created}",
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

        content.update("\n".join(lines))

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

        # Count states
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
