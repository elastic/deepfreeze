"""UpdateDateRanges action for deepfreeze.

Walk every mounted repository, query its indices' ``@timestamp`` min/max,
and persist the result back onto the repository's status document. Designed
to run on a tight cadence (e.g. hourly) so the status index keeps pace with
newly-ingested data instead of waiting for the next Rotate.

Net-new vs. the historical Python surface: ``Rotate._update_date_ranges``
already does the equivalent inline as part of rotation. This action lifts the
same ``update_repository_date_range`` primitive into its own schedulable
action so operators can drive the cadence independently of rotate. It is the
Python back-port of the Kibana plugin's ``runUpdateDateRanges``
(``kibana-plugin/server/actions/update_date_ranges.ts``).

Differs intentionally from ``RepairMetadata._update_date_ranges``:
  - RepairMetadata only fills MISSING start/end (a one-shot repair).
  - This action processes EVERY mounted repo and lets the helper's
    only-extend, never-shrink merge rule extend existing ranges. That's the
    right behavior for periodic re-runs as new data arrives.

Storage-provider-free by design: every operation is an Elasticsearch
round-trip (snapshot list + index exists + min/max agg + status-doc write).
Safe to schedule on a tight interval without touching S3/Azure/GCP.
"""

# pylint: disable=too-many-arguments,too-many-instance-attributes,raise-missing-from

import logging

from elasticsearch8 import Elasticsearch
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from deepfreeze_core.audit import AuditLogger
from deepfreeze_core.constants import STATUS_INDEX
from deepfreeze_core.exceptions import MissingIndexError
from deepfreeze_core.utilities import get_all_repos, update_repository_date_range


class UpdateDateRanges:
    """Extend each mounted repository's recorded date range from live indices.

    :param client: A client connection object
    :param porcelain: Emit tab-delimited machine output instead of rich tables
    :param audit: Optional audit logger for recording the run

    :methods:
        do_dry_run: Report which mounted repos would be scanned, without writing
        do_action: Query and persist (extend) each mounted repo's date range

    :example:
        >>> from deepfreeze_core.actions import UpdateDateRanges
        >>> UpdateDateRanges(client).do_action()
    """

    def __init__(
        self,
        client: Elasticsearch,
        porcelain: bool = False,
        audit: AuditLogger = None,
        **kwargs,  # Accept extra kwargs for compatibility with curator CLI
    ) -> None:
        self.loggit = logging.getLogger("deepfreeze.actions.update_date_ranges")
        self.loggit.debug("Initializing Deepfreeze UpdateDateRanges")

        # Console for STDERR output
        self.console = Console(stderr=True)

        self.client = client
        self.porcelain = porcelain
        self.audit = audit

        # Per-repo outcome records, surfaced by the server's job-detail extractor.
        self._results = []

        self.loggit.debug("Deepfreeze UpdateDateRanges initialized")

    def _check_status_index(self) -> None:
        """Ensure the status index exists before we try to read repos."""
        if not self.client.indices.exists(index=STATUS_INDEX):
            raise MissingIndexError(f"Status index {STATUS_INDEX} does not exist")

    def _update_date_ranges(self, dry_run: bool = False) -> list:
        """Walk all repos and (for mounted ones) extend their date range.

        Unmounted repos can't be queried for ``@timestamp`` — there are no live
        indices to aggregate over — so they are recorded as skipped. Mounted
        repos are always processed; the only-extend merge in
        ``update_repository_date_range`` makes repeated runs idempotent when no
        new data has arrived.

        :param dry_run: If True, report intent without persisting anything
        :return: List of per-repo outcome dicts
        """
        results = []
        repos = get_all_repos(self.client)
        self.loggit.debug("update_date_ranges: scanning %d repo(s)", len(repos))

        for repo in repos:
            if not repo.is_mounted:
                self.loggit.debug(
                    "Skipping date range update for unmounted repo %s", repo.name
                )
                results.append(
                    {
                        "repo": repo.name,
                        "action": "skipped",
                        "reason": "repo not mounted; @timestamp unavailable",
                        "old_start": repo.start.isoformat() if repo.start else None,
                        "old_end": repo.end.isoformat() if repo.end else None,
                        "new_start": None,
                        "new_end": None,
                        "error": None,
                    }
                )
                continue

            old_start = repo.start
            old_end = repo.end
            result = {
                "repo": repo.name,
                "action": "unchanged",
                "reason": None,
                "old_start": old_start.isoformat() if old_start else None,
                "old_end": old_end.isoformat() if old_end else None,
                "new_start": old_start.isoformat() if old_start else None,
                "new_end": old_end.isoformat() if old_end else None,
                "error": None,
            }

            if dry_run:
                result["action"] = "would_scan"
                results.append(result)
                continue

            try:
                # update_repository_date_range mutates repo.start/end in place and
                # persists, returning True only when the range actually changed.
                if update_repository_date_range(self.client, repo):
                    result["action"] = "updated"
                    result["new_start"] = repo.start.isoformat() if repo.start else None
                    result["new_end"] = repo.end.isoformat() if repo.end else None
                    self.loggit.info(
                        "Extended date range for %s: %s..%s -> %s..%s",
                        repo.name,
                        result["old_start"],
                        result["old_end"],
                        result["new_start"],
                        result["new_end"],
                    )
                else:
                    result["reason"] = "no change after only-extend merge"
            except Exception as e:
                result["action"] = "failed"
                result["error"] = str(e)
                self.loggit.error(
                    "Failed to update date range for %s: %s", repo.name, e
                )

            results.append(result)

        return results

    def do_dry_run(self) -> None:
        """Report which mounted repos would be scanned, without writing."""
        self.loggit.info("DRY-RUN MODE.  No changes will be made.")

        tracker = None
        if self.audit:
            tracker = self.audit.start_tracking(
                action="update_date_ranges",
                dry_run=True,
                parameters={},
            )

        try:
            self._check_status_index()
            results = self._update_date_ranges(dry_run=True)
            self._results = results

            scannable = [r for r in results if r["action"] == "would_scan"]
            skipped = [r for r in results if r["action"] == "skipped"]

            if tracker:
                for r in results:
                    tracker.add_result(
                        {
                            "type": "date_range",
                            "repository": r["repo"],
                            "action": r["action"],
                        }
                    )
                tracker.set_summary(
                    {
                        "repos_to_scan": len(scannable),
                        "repos_skipped": len(skipped),
                    }
                )

            if self.porcelain:
                for r in results:
                    print(f"DATE_RANGE\t{r['action'].upper()}\t{r['repo']}")
                print(
                    f"SUMMARY\t{len(scannable)} mounted repos to scan\t"
                    f"{len(skipped)} skipped"
                )
                return

            if not scannable:
                self.console.print(
                    Panel(
                        "[yellow]No mounted repositories to scan.[/yellow]",
                        title="[bold blue]Dry Run Summary[/bold blue]",
                        border_style="blue",
                        expand=False,
                    )
                )
                return

            table = Table(title="Repositories To Scan For Date Ranges")
            table.add_column("Repository", style="cyan")
            table.add_column("Current Start", style="yellow")
            table.add_column("Current End", style="yellow")
            for r in scannable:
                table.add_row(
                    r["repo"],
                    r["old_start"] or "∅",
                    r["old_end"] or "∅",
                )
            self.console.print(table)
            self.console.print(
                Panel(
                    f"[bold]Would scan {len(scannable)} mounted repo(s)[/bold] "
                    f"({len(skipped)} unmounted skipped)\n\n"
                    f"Run without [yellow]--dry-run[/yellow] to update.",
                    title="[bold blue]Dry Run Summary[/bold blue]",
                    border_style="blue",
                    expand=False,
                )
            )

        except MissingIndexError as e:
            if tracker:
                tracker.add_error({"code": type(e).__name__, "message": str(e)})
            if self.porcelain:
                print(f"ERROR\t{type(e).__name__}\t{str(e)}")
            else:
                self.console.print(f"[red]Error: {e}[/red]")
            raise
        finally:
            if self.audit and tracker:
                self.audit.commit(tracker)

    def do_action(self) -> None:
        """Query and persist (extend) each mounted repo's date range."""
        self.loggit.debug("Starting UpdateDateRanges action")

        tracker = None
        if self.audit:
            tracker = self.audit.start_tracking(
                action="update_date_ranges",
                dry_run=False,
                parameters={},
            )

        try:
            self._check_status_index()
            results = self._update_date_ranges(dry_run=False)
            self._results = results

            updated = [r for r in results if r["action"] == "updated"]
            unchanged = [r for r in results if r["action"] == "unchanged"]
            skipped = [r for r in results if r["action"] == "skipped"]
            failed = [r for r in results if r["action"] == "failed"]

            if tracker:
                for r in results:
                    row = {
                        "type": "date_range",
                        "repository": r["repo"],
                        "action": r["action"],
                        "status": "failed" if r["action"] == "failed" else "success",
                    }
                    if r["action"] == "updated":
                        row["start"] = r["new_start"]
                        row["end"] = r["new_end"]
                    if r["error"]:
                        row["error"] = r["error"]
                    tracker.add_result(row)
                tracker.set_summary(
                    {
                        "repos_updated": len(updated),
                        "repos_unchanged": len(unchanged),
                        "repos_skipped": len(skipped),
                        "failures": len(failed),
                    }
                )

            if self.porcelain:
                for r in results:
                    if r["action"] == "updated":
                        print(
                            f"DATE_RANGE\tUPDATED\t{r['repo']}\t"
                            f"{r['new_start']}\t{r['new_end']}"
                        )
                    elif r["action"] == "failed":
                        print(f"DATE_RANGE\tFAILED\t{r['repo']}\t{r['error']}")
                    else:
                        print(f"DATE_RANGE\t{r['action'].upper()}\t{r['repo']}")
                print(
                    f"COMPLETE\t{len(updated)} updated\t{len(unchanged)} unchanged\t"
                    f"{len(skipped)} skipped\t{len(failed)} failed"
                )
                return

            if not updated and not failed:
                self.console.print(
                    Panel(
                        "[green]All repository date ranges are up to date.[/green]",
                        title="[bold green]Update Complete[/bold green]",
                        border_style="green",
                        expand=False,
                    )
                )
                return

            table = Table(title="Date Range Updates")
            table.add_column("Repository", style="cyan")
            table.add_column("Status", style="white")
            table.add_column("Start", style="green")
            table.add_column("End", style="green")
            for r in updated:
                table.add_row(r["repo"], "updated", r["new_start"], r["new_end"])
            for r in failed:
                table.add_row(
                    r["repo"], f"[red]failed: {r['error'][:30]}[/red]", "—", "—"
                )
            self.console.print(table)
            self.console.print(
                Panel(
                    f"[bold]{len(updated)} updated[/bold], {len(unchanged)} unchanged, "
                    f"{len(skipped)} skipped, {len(failed)} failed.",
                    title=(
                        "[bold green]Update Complete[/bold green]"
                        if not failed
                        else "[bold yellow]Update Completed With Errors[/bold yellow]"
                    ),
                    border_style="green" if not failed else "yellow",
                    expand=False,
                )
            )

        except MissingIndexError as e:
            if tracker:
                tracker.add_error({"code": type(e).__name__, "message": str(e)})
            if self.porcelain:
                print(f"ERROR\t{type(e).__name__}\t{str(e)}")
            else:
                self.console.print(f"[red]Error: {e}[/red]")
            raise
        finally:
            if self.audit and tracker:
                self.audit.commit(tracker)
