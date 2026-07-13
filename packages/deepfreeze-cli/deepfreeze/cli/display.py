"""Display helpers for rendering remote API responses in the terminal."""

import json

from rich.console import Console
from rich.table import Table

console = Console(stderr=True)


def display_status(data: dict, porcelain: bool = False) -> None:
    """Render system status from the API response."""
    if porcelain:
        print(json.dumps(data, indent=2))
        return

    settings = data.get("settings")
    repos = data.get("repositories", [])
    thaw_requests = data.get("thaw_requests", [])
    buckets = data.get("buckets", [])
    ilm_policies = data.get("ilm_policies", [])
    errors = data.get("errors", [])

    if errors:
        for err in errors:
            msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            console.print(f"[red]Error:[/red] {msg}")
            remediation = err.get("remediation") if isinstance(err, dict) else None
            if remediation:
                console.print(f"  [dim]{remediation}[/dim]")
        return

    # Config
    if settings:
        t = Table(title="Deepfreeze Configuration")
        t.add_column("Setting", style="white")
        t.add_column("Value", style="cyan")
        for key, val in settings.items():
            if val is not None:
                t.add_row(key, str(val))
        console.print(t)
        console.print()

    # Repos
    if repos:
        t = Table(title="Repositories")
        t.add_column("Name", style="cyan")
        t.add_column("Bucket", style="yellow")
        t.add_column("Base Path", style="white")
        t.add_column("Mounted", style="green")
        t.add_column("Thaw State", style="magenta")
        t.add_column("Storage Tier", style="blue")
        for repo in sorted(repos, key=lambda x: x.get("name", "")):
            mounted = "[green]Yes[/green]" if repo.get("is_mounted") else "[red]No[/red]"
            t.add_row(
                repo.get("name", ""),
                repo.get("bucket", ""),
                repo.get("base_path", ""),
                mounted,
                repo.get("thaw_state", ""),
                repo.get("storage_tier", ""),
            )
        console.print(t)
        console.print()

    # Thaw requests
    if thaw_requests:
        t = Table(title="Thaw Requests")
        t.add_column("ID", style="cyan")
        t.add_column("Status", style="yellow")
        t.add_column("Created", style="white")
        t.add_column("Repos", style="white")
        for req in thaw_requests:
            repos_list = req.get("repos", [])
            t.add_row(
                req.get("request_id", ""),
                req.get("status", ""),
                req.get("created", "")[:16] if req.get("created") else "",
                str(len(repos_list)) if repos_list else "0",
            )
        console.print(t)
        console.print()

    # Buckets
    if buckets:
        t = Table(title="Buckets")
        t.add_column("Name", style="cyan")
        t.add_column("Object Count", style="white")
        for b in buckets:
            t.add_row(b.get("name", ""), str(b.get("object_count", "")))
        console.print(t)
        console.print()

    # ILM
    if ilm_policies:
        t = Table(title="ILM Policies")
        t.add_column("Name", style="cyan")
        t.add_column("Repository", style="yellow")
        t.add_column("Indices", style="white")
        t.add_column("Data Streams", style="white")
        for p in ilm_policies:
            t.add_row(
                p.get("name", ""),
                p.get("repository", ""),
                str(p.get("indices_count", 0)),
                str(p.get("data_streams_count", 0)),
            )
        console.print(t)


def display_command_result(data: dict, porcelain: bool = False) -> None:
    """Render a CommandResult from the API response."""
    if porcelain:
        print(json.dumps(data, indent=2))
        return

    success = data.get("success", False)
    action = data.get("action", "unknown")
    dry_run = data.get("dry_run", False)
    summary = data.get("summary", "")
    errors = data.get("errors", [])
    details = data.get("details", [])
    duration = data.get("duration_ms", 0)

    prefix = "[dim]DRY RUN:[/dim] " if dry_run else ""
    if success:
        console.print(f"{prefix}[green]✓[/green] {action}: {summary}")
    else:
        console.print(f"{prefix}[red]✗[/red] {action}: {summary}")

    for detail in details:
        target = detail.get("target", "")
        status = detail.get("status", "")
        console.print(f"  {detail.get('type', '')}: {target} → {status}")

    for err in errors:
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        console.print(f"  [red]Error:[/red] {msg}")
        remediation = err.get("remediation") if isinstance(err, dict) else None
        if remediation:
            console.print(f"    [dim]{remediation}[/dim]")

    if duration:
        console.print(f"  [dim]Duration: {duration}ms[/dim]")


def display_job_submitted(data: dict) -> None:
    """Display a 202 response (job still running)."""
    job_id = data.get("job_id", data.get("id", "unknown"))
    status = data.get("status", "unknown")
    console.print(f"[yellow]Job {job_id} submitted ({status})[/yellow]")
    console.print(f"  Check progress: deepfreeze jobs {job_id}")
