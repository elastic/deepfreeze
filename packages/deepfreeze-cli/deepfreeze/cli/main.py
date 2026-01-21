"""
Deepfreeze CLI entry point

This module provides the main CLI entry point for the standalone deepfreeze package.
It mirrors the interface of `curator_cli deepfreeze` exactly.
"""

import logging
from datetime import datetime
from pathlib import Path

import click
from deepfreeze_core import ActionError, DeepfreezeException, create_es_client

from deepfreeze import __version__
from deepfreeze.config import (
    configure_logging,
    get_elasticsearch_config,
    load_config,
)

today = datetime.today()

# Default config file location
DEFAULT_CONFIG_PATH = Path.home() / ".deepfreeze" / "config.yml"


def get_default_config_file():
    """
    Get the default configuration file path if it exists.

    :returns: Path to ~/.deepfreeze/config.yml if it exists, None otherwise
    """
    if DEFAULT_CONFIG_PATH.is_file():
        return str(DEFAULT_CONFIG_PATH)
    return None


def get_client_from_context(ctx):
    """
    Get or create an Elasticsearch client from the CLI context.

    This lazily creates the client on first use.
    """
    if "client" not in ctx.obj or ctx.obj["client"] is None:
        config = ctx.obj.get("configdict", {})
        try:
            es_config = get_elasticsearch_config(config)
            ctx.obj["client"] = create_es_client(**es_config)
        except Exception as e:
            click.echo(f"Error connecting to Elasticsearch: {e}", err=True)
            ctx.exit(1)
    return ctx.obj["client"]


@click.group()
@click.version_option(version=__version__, prog_name="deepfreeze")
@click.option(
    "--config",
    "-c",
    "config_path",
    type=click.Path(exists=True),
    default=None,
    help=f"Path to configuration file (default: {DEFAULT_CONFIG_PATH})",
)
@click.option(
    "--dry-run",
    is_flag=True,
    default=False,
    help="Do not perform any changes, only show what would happen",
)
@click.pass_context
def cli(ctx, config_path, dry_run):
    """
    Deepfreeze - Elasticsearch S3 Glacier archival tool

    Provides cost-effective S3 Glacier archival and lifecycle management
    for Elasticsearch snapshot repositories.

    \b
    Configuration:
      Default config file: ~/.deepfreeze/config.yml
      Override with: --config /path/to/config.yml

    \b
    Available commands:
      setup           Initialize deepfreeze environment
      status          Show deepfreeze status
      rotate          Rotate repositories (create new, archive old)
      thaw            Thaw frozen repositories
      refreeze        Refreeze thawed repositories
      cleanup         Clean up expired repositories
      repair-metadata Repair metadata discrepancies
    """
    ctx.ensure_object(dict)
    ctx.obj["dry_run"] = dry_run

    # Use default config if none provided
    using_default_config = False
    if config_path is None:
        config_path = get_default_config_file()
        if config_path:
            using_default_config = True

    # Load configuration
    try:
        config = load_config(config_path)
        ctx.obj["configdict"] = config
        ctx.obj["config_path"] = config_path

        # Configure logging first
        configure_logging(config)

        # Now log the config path (after logging is configured)
        if using_default_config:
            logging.getLogger("deepfreeze.cli").info(
                "Using default config: %s", config_path
            )

        # Client will be created lazily when needed
        ctx.obj["client"] = None

    except ActionError as e:
        click.echo(f"Configuration error: {e}", err=True)
        ctx.exit(1)


@cli.command()
@click.option(
    "-y",
    "--year",
    type=int,
    default=today.year,
    show_default=True,
    help="Year for the new repo. Only used if style=date.",
)
@click.option(
    "-m",
    "--month",
    type=int,
    default=today.month,
    show_default=True,
    help="Month for the new repo. Only used if style=date.",
)
@click.option(
    "-r",
    "--repo_name_prefix",
    type=str,
    default="deepfreeze",
    show_default=True,
    help="prefix for naming rotating repositories",
)
@click.option(
    "-b",
    "--bucket_name_prefix",
    type=str,
    default="deepfreeze",
    show_default=True,
    help="prefix for naming buckets",
)
@click.option(
    "-d",
    "--base_path_prefix",
    type=str,
    default="snapshots",
    show_default=True,
    help="base path in the bucket to use for searchable snapshots",
)
@click.option(
    "-a",
    "--canned_acl",
    type=click.Choice(
        [
            "private",
            "public-read",
            "public-read-write",
            "authenticated-read",
            "log-delivery-write",
            "bucket-owner-read",
            "bucket-owner-full-control",
        ]
    ),
    default="private",
    show_default=True,
    help="Canned ACL as defined by AWS",
)
@click.option(
    "-s",
    "--storage_class",
    type=click.Choice(
        [
            "standard",
            "reduced_redundancy",
            "standard_ia",
            "intelligent_tiering",
            "onezone_ia",
        ]
    ),
    default="standard",
    show_default=True,
    help="What storage class to use, as defined by AWS",
)
@click.option(
    "-o",
    "--provider",
    type=click.Choice(["aws", "azure", "gcp"]),
    default="aws",
    help="Cloud storage provider to use (aws, azure, or gcp)",
)
@click.option(
    "-t",
    "--rotate_by",
    type=click.Choice(
        [
            #    "bucket",
            "path",
        ]
    ),
    default="path",
    help="Rotate by path. This is the only option available for now",
)
@click.option(
    "-n",
    "--style",
    type=click.Choice(
        [
            # "date",
            "oneup",
        ]
    ),
    default="oneup",
    help="How to number (suffix) the rotating repositories. Oneup is the only option available for now.",
)
@click.option(
    "-i",
    "--ilm_policy_name",
    type=str,
    required=True,
    help="Name of the ILM policy to create/modify. If the policy exists, it will be "
    "updated to use the deepfreeze repository. If not, a new policy will be created "
    "with tiering: 7d hot, 30d cold, 365d frozen, then delete.",
)
@click.option(
    "-x",
    "--index_template_name",
    type=str,
    required=True,
    help="Name of the index template to attach the ILM policy to. "
    "The template will be updated to use the specified ILM policy.",
)
@click.option(
    "-p",
    "--porcelain",
    is_flag=True,
    default=False,
    help="Machine-readable output (tab-separated values, no formatting)",
)
@click.pass_context
def setup(
    ctx,
    year,
    month,
    repo_name_prefix,
    bucket_name_prefix,
    base_path_prefix,
    canned_acl,
    storage_class,
    provider,
    rotate_by,
    style,
    ilm_policy_name,
    index_template_name,
    porcelain,
):
    """
    Set up a cluster for deepfreeze and save the configuration for all future actions.

    Setup can be tuned by setting the following options to override defaults. Note that
    --year and --month are only used if style=date. If style=oneup, then year and month
    are ignored.

    Depending on the S3 provider chosen, some options might not be available, or option
    values may vary.

    \b
    ILM Policy Configuration (--ilm_policy_name, REQUIRED):
      - If the policy exists: Updates it to use the deepfreeze repository
      - If not: Creates a new policy with tiering strategy:
        * Hot: 7 days (with rollover at 45GB or 7d)
        * Cold: 30 days
        * Frozen: 365 days (searchable snapshot to deepfreeze repo)
        * Delete: after frozen phase (delete_searchable_snapshot=false)

    \b
    Index Template Configuration (--index_template_name, REQUIRED):
      - The template will be updated to use the specified ILM policy
      - Ensures new indices will automatically use the deepfreeze ILM policy
    """
    from deepfreeze_core.actions import Setup

    client = get_client_from_context(ctx)

    # Azure container names don't allow underscores - offer to convert them
    if provider == "azure":
        names_to_check = {
            "bucket_name_prefix": bucket_name_prefix,
            "repo_name_prefix": repo_name_prefix,
            "base_path_prefix": base_path_prefix,
        }
        names_with_underscores = {
            name: value
            for name, value in names_to_check.items()
            if value and "_" in value
        }
        if names_with_underscores:
            converted = {
                name: value.replace("_", "-")
                for name, value in names_with_underscores.items()
            }
            click.echo(
                "Azure container names cannot contain underscores. "
                "The following names would be converted:"
            )
            for name, value in names_with_underscores.items():
                click.echo(f"  {name}: {value} -> {converted[name]}")

            if not click.confirm("Do you want to proceed with these converted names?"):
                click.echo("Aborted. Please provide names without underscores.")
                ctx.exit(1)

            # Apply conversions
            if "bucket_name_prefix" in converted:
                bucket_name_prefix = converted["bucket_name_prefix"]
            if "repo_name_prefix" in converted:
                repo_name_prefix = converted["repo_name_prefix"]
            if "base_path_prefix" in converted:
                base_path_prefix = converted["base_path_prefix"]

    action = Setup(
        client=client,
        year=year,
        month=month,
        repo_name_prefix=repo_name_prefix,
        bucket_name_prefix=bucket_name_prefix,
        base_path_prefix=base_path_prefix,
        canned_acl=canned_acl,
        storage_class=storage_class,
        provider=provider,
        rotate_by=rotate_by,
        style=style,
        ilm_policy_name=ilm_policy_name,
        index_template_name=index_template_name,
        porcelain=porcelain,
    )

    try:
        if ctx.obj["dry_run"]:
            action.do_dry_run()
        else:
            action.do_action()
    except DeepfreezeException as e:
        if not porcelain:
            click.echo(f"Error: {e}", err=True)
        ctx.exit(1)


@cli.command()
@click.option(
    "-y",
    "--year",
    type=int,
    default=today.year,
    help="Year for the new repo (default is today)",
)
@click.option(
    "-m",
    "--month",
    type=int,
    default=today.month,
    help="Month for the new repo (default is today)",
)
@click.option(
    "-k",
    "--keep",
    type=int,
    default=6,
    help="How many repositories should remain mounted?",
)
@click.option(
    "-p",
    "--porcelain",
    is_flag=True,
    default=False,
    help="Machine-readable output (tab-separated values, no formatting)",
)
@click.pass_context
def rotate(
    ctx,
    year,
    month,
    keep,
    porcelain,
):
    """
    Deepfreeze rotation (add a new repo and age oldest off)
    """
    from deepfreeze_core.actions import Rotate

    client = get_client_from_context(ctx)

    action = Rotate(
        client=client,
        year=year,
        month=month,
        keep=keep,
        porcelain=porcelain,
    )

    try:
        if ctx.obj["dry_run"]:
            action.do_dry_run()
        else:
            action.do_action()
    except DeepfreezeException as e:
        if not porcelain:
            click.echo(f"Error: {e}", err=True)
        ctx.exit(1)


@cli.command()
@click.option(
    "-l",
    "--limit",
    type=int,
    default=None,
    help="Limit display to the last N repositories (default: show all)",
)
@click.option(
    "-r",
    "--repos",
    is_flag=True,
    default=False,
    help="Show repositories section only",
)
@click.option(
    "-t",
    "--thawed",
    is_flag=True,
    default=False,
    help="Show thawed repositories section only",
)
@click.option(
    "-b",
    "--buckets",
    is_flag=True,
    default=False,
    help="Show buckets section only",
)
@click.option(
    "-i",
    "--ilm",
    is_flag=True,
    default=False,
    help="Show ILM policies section only",
)
@click.option(
    "-c",
    "--config",
    "show_config_flag",
    is_flag=True,
    default=False,
    help="Show configuration section only",
)
@click.option(
    "-p",
    "--porcelain",
    is_flag=True,
    default=False,
    help="Output plain text without formatting (suitable for scripting)",
)
@click.pass_context
def status(
    ctx,
    limit,
    repos,
    thawed,
    buckets,
    ilm,
    show_config_flag,
    porcelain,
):
    """
    Show the status of deepfreeze

    By default, all sections are displayed. Use section flags (-r, -t, -b, -i, -c) to show specific sections only.
    Multiple section flags can be combined.
    """
    from deepfreeze_core.actions import Status

    client = get_client_from_context(ctx)

    # Create action with all status parameters
    action = Status(
        client=client,
        porcelain=porcelain,
        limit=limit,
        show_repos=repos,
        show_thawed=thawed,
        show_buckets=buckets,
        show_ilm=ilm,
        show_config=show_config_flag,
    )

    try:
        if ctx.obj["dry_run"]:
            action.do_dry_run()
        else:
            action.do_action()
    except DeepfreezeException as e:
        if not porcelain:
            click.echo(f"Error: {e}", err=True)
        ctx.exit(1)


@cli.command()
@click.option(
    "-f",
    "--refrozen-retention-days",
    type=int,
    default=None,
    help="Override retention period for refrozen thaw requests (default: from config, typically 35 days)",
)
@click.option(
    "-p",
    "--porcelain",
    is_flag=True,
    default=False,
    help="Machine-readable output (tab-separated values, no formatting)",
)
@click.pass_context
def cleanup(
    ctx,
    refrozen_retention_days,
    porcelain,
):
    """
    Clean up expired thawed repositories
    """
    from deepfreeze_core.actions import Cleanup

    client = get_client_from_context(ctx)

    action = Cleanup(
        client=client,
        porcelain=porcelain,
        refrozen_retention_days=refrozen_retention_days,
    )

    try:
        if ctx.obj["dry_run"]:
            action.do_dry_run()
        else:
            action.do_action()
    except DeepfreezeException as e:
        if not porcelain:
            click.echo(f"Error: {e}", err=True)
        ctx.exit(1)


@cli.command()
@click.option(
    "-t",
    "--thaw-request-id",
    "thaw_request_id",
    type=str,
    default=None,
    help="The ID of the thaw request to refreeze (optional - if not provided, all open requests)",
)
@click.option(
    "-p",
    "--porcelain",
    is_flag=True,
    default=False,
    help="Machine-readable output (tab-separated values, no formatting)",
)
@click.pass_context
def refreeze(
    ctx,
    thaw_request_id,
    porcelain,
):
    """
    Unmount repositories from thaw request(s) and reset them to frozen state.

    This is a user-initiated operation to signal "I'm done with this thaw."
    It unmounts all repositories associated with the thaw request(s) and resets
    their state back to frozen, even if the S3 restore hasn't expired yet.

    \b
    Two modes of operation:
    1. Specific request: Provide -t <thaw-request-id> to refreeze one request
    2. All open requests: Omit -t to refreeze all open requests (requires confirmation)

    \b
    Examples:

      # Refreeze a specific thaw request

      deepfreeze refreeze -t <thaw-request-id>

      # Refreeze all open thaw requests (with confirmation)

      deepfreeze refreeze
    """
    from deepfreeze_core.actions import Refreeze

    client = get_client_from_context(ctx)

    # Determine if refreezing all requests
    all_requests = thaw_request_id is None

    action = Refreeze(
        client=client,
        request_id=thaw_request_id,
        all_requests=all_requests,
        porcelain=porcelain,
    )

    try:
        if ctx.obj["dry_run"]:
            action.do_dry_run()
        else:
            action.do_action()
    except DeepfreezeException as e:
        if not porcelain:
            click.echo(f"Error: {e}", err=True)
        ctx.exit(1)


@cli.command()
@click.option(
    "-s",
    "--start-date",
    type=str,
    default=None,
    help="Start of date range in ISO 8601 format (e.g., 2025-01-15T00:00:00Z)",
)
@click.option(
    "-e",
    "--end-date",
    type=str,
    default=None,
    help="End of date range in ISO 8601 format (e.g., 2025-01-31T23:59:59Z)",
)
@click.option(
    "--sync/--async",
    "sync",
    default=False,
    show_default=True,
    help="Wait for restore and mount (sync) or return immediately (async)",
)
@click.option(
    "-d",
    "--duration",
    type=int,
    default=30,
    show_default=True,
    help="Number of days to keep objects restored from Glacier",
)
@click.option(
    "-t",
    "--retrieval-tier",
    type=click.Choice(["Standard", "Expedited", "Bulk"]),
    default="Standard",
    show_default=True,
    help="AWS Glacier retrieval tier",
)
@click.option(
    "-k",
    "--check-status",
    "check_status",
    type=str,
    is_flag=False,
    flag_value="",  # Empty string when used without a value
    default=None,
    help="Check status of thaw request(s). Provide ID for specific request, or no value to check all",
)
@click.option(
    "-l",
    "--list",
    "list_requests",
    is_flag=True,
    default=False,
    help="List all active thaw requests",
)
@click.option(
    "-c",
    "--include-completed",
    "include_completed",
    is_flag=True,
    default=False,
    help="Include completed requests when listing (default: exclude completed)",
)
@click.option(
    "-p",
    "--porcelain",
    is_flag=True,
    default=False,
    help="Machine-readable output (tab-separated values, no formatting)",
)
@click.pass_context
def thaw(
    ctx,
    start_date,
    end_date,
    sync,
    duration,
    retrieval_tier,
    check_status,
    list_requests,
    include_completed,
    porcelain,
):
    """
    Thaw repositories from Glacier storage for a specified date range,
    or check status of existing thaw requests.

    \b
    Four modes of operation:
    1. Create new thaw: Requires --start-date and --end-date
    2. Check specific request: Use --check-status <thaw-id> (mounts if ready)
    3. Check all requests: Use --check-status (without value, mounts if ready)
    4. List requests: Use --list (shows summary table)

    \b
    Examples:

      # Create new thaw request (async)

      deepfreeze thaw -s 2025-01-01T00:00:00Z -e 2025-01-15T23:59:59Z --async

      # Create new thaw request (sync - waits for completion)

      deepfreeze thaw -s 2025-01-01T00:00:00Z -e 2025-01-15T23:59:59Z --sync

      # Check status of a specific request and mount if ready

      deepfreeze thaw --check-status <thaw-id>
      deepfreeze thaw -k <thaw-id>

      # Check status of ALL thaw requests and mount if ready

      deepfreeze thaw --check-status
      deepfreeze thaw -k

      # List active thaw requests (excludes completed by default)

      deepfreeze thaw --list
      deepfreeze thaw -l

      # List all thaw requests (including completed)

      deepfreeze thaw --list --include-completed
      deepfreeze thaw -l -c
    """
    from datetime import datetime as dt

    from deepfreeze_core.actions import Thaw

    # Validate mutual exclusivity
    # Note: check_status can be None (not provided), "" (flag without value), or a string ID
    modes_active = sum(
        [bool(start_date or end_date), check_status is not None, bool(list_requests)]
    )

    if modes_active == 0:
        click.echo(
            "Error: Must specify one of: --start-date/--end-date (-s/-e), --check-status (-k), or --list (-l)",
            err=True,
        )
        ctx.exit(1)

    if modes_active > 1:
        click.echo(
            "Error: Cannot use --start-date/--end-date with --check-status (-k) or --list (-l)",
            err=True,
        )
        ctx.exit(1)

    # Validate that create mode has both start and end dates
    if (start_date or end_date) and not (start_date and end_date):
        click.echo(
            "Error: Both --start-date and --end-date are required for creating a new thaw request",
            err=True,
        )
        ctx.exit(1)

    # Parse dates if provided
    parsed_start_date = None
    parsed_end_date = None
    if start_date and end_date:
        try:
            # Parse ISO 8601 format
            parsed_start_date = dt.fromisoformat(start_date.replace("Z", "+00:00"))
            parsed_end_date = dt.fromisoformat(end_date.replace("Z", "+00:00"))
        except ValueError as e:
            click.echo(f"Error parsing dates: {e}", err=True)
            ctx.exit(1)

    client = get_client_from_context(ctx)

    # Determine request_id from check_status
    request_id = None
    if check_status is not None and check_status != "":
        request_id = check_status

    action = Thaw(
        client=client,
        start_date=parsed_start_date,
        end_date=parsed_end_date,
        request_id=request_id,
        list_requests=list_requests,
        restore_days=duration,
        retrieval_tier=retrieval_tier,
        sync=sync,
        porcelain=porcelain,
        include_completed=include_completed,
    )

    try:
        if ctx.obj["dry_run"]:
            action.do_dry_run()
        else:
            action.do_action()
    except DeepfreezeException as e:
        if not porcelain:
            click.echo(f"Error: {e}", err=True)
        ctx.exit(1)


@cli.command(name="repair-metadata")
@click.option(
    "-p",
    "--porcelain",
    is_flag=True,
    default=False,
    help="Output plain text without formatting (suitable for scripting)",
)
@click.pass_context
def repair_metadata(ctx, porcelain):
    """
    Repair repository metadata to match actual S3 storage state

    Scans all repositories and checks if their metadata (thaw_state) matches
    the actual S3 storage class. Repositories stored in GLACIER should have
    thaw_state='frozen', but sometimes metadata can get out of sync.

    This command will:
    - Scan all repositories in the status index
    - Check actual S3 storage class for each repository
    - Update thaw_state='frozen' for repositories actually in GLACIER
    - Report on all changes made

    Use --dry-run to see what would be changed without making modifications.
    """
    from deepfreeze_core.actions import RepairMetadata

    client = get_client_from_context(ctx)

    action = RepairMetadata(
        client=client,
        porcelain=porcelain,
    )

    try:
        if ctx.obj["dry_run"]:
            action.do_dry_run()
        else:
            action.do_action()
    except DeepfreezeException as e:
        if not porcelain:
            click.echo(f"Error: {e}", err=True)
        ctx.exit(1)


if __name__ == "__main__":
    cli()
