"""Setup action for deepfreeze"""

# pylint: disable=too-many-arguments,too-many-instance-attributes, raise-missing-from

import logging

from elasticsearch8 import Elasticsearch
from rich.console import Console
from rich.markup import escape
from rich.panel import Panel

from deepfreeze_core.audit import AuditLogger
from deepfreeze_core.constants import STATUS_INDEX
from deepfreeze_core.exceptions import ActionError, PreconditionError
from deepfreeze_core.helpers import Settings
from deepfreeze_core.s3client import s3_client_factory
from deepfreeze_core.utilities import (
    create_or_update_ilm_policy,
    create_repo,
    ensure_settings_index,
    save_settings,
    update_index_template_ilm_policy,
)


class Setup:
    """
    Setup is responsible for creating the initial repository and bucket for
    deepfreeze operations, and optionally configuring ILM policies and index templates.

    :param client: A client connection object
    :param repo_name_prefix: A prefix for repository names, defaults to `deepfreeze`
    :param bucket_name_prefix: A prefix for bucket names, defaults to `deepfreeze`
    :param base_path_prefix: Path within a bucket where snapshots are stored, defaults to `snapshots`
    :param canned_acl: One of the AWS canned ACL values (see
        `<https://docs.aws.amazon.com/AmazonS3/latest/userguide/acl-overview.html#canned-acl>`),
        defaults to `private`
    :param storage_class: AWS Storage class (see `<https://aws.amazon.com/s3/storage-classes/>`),
        defaults to `intelligent_tiering`
    :param provider: The provider to use (AWS only for now), defaults to `aws`, and will be saved
        to the deepfreeze status index for later reference.
    :param rotate_by: Rotate by bucket or path within a bucket?, defaults to `path`
    :param ilm_policy_name: Name of the ILM policy to create or modify. If specified and the
        policy exists, it will be updated to use the deepfreeze repository. If it does not exist,
        a new policy will be created with a reasonable tiering strategy:
        Hot (7d) -> Cold (30d) -> Frozen (365d) -> Delete (delete_searchable_snapshot=false)
    :param index_template_name: Name of the index template to attach the ILM policy to.
        Requires ilm_policy_name to be specified.

    :raises RepositoryException: If a repository with the given prefix already exists

    :methods:
        do_dry_run: Perform a dry-run of the setup process.
        do_action: Perform create initial bucket and repository.

    :example:
        >>> from deepfreeze_core.actions import Setup
        >>> setup = Setup(client, repo_name_prefix="deepfreeze", bucket_name_prefix="deepfreeze",
        ...               base_path_prefix="snapshots", canned_acl="private",
        ...               storage_class="intelligent_tiering", provider="aws", rotate_by="path",
        ...               ilm_policy_name="my-ilm-policy", index_template_name="my-template")
        >>> setup.do_dry_run()
        >>> setup.do_action()
    """

    def __init__(
        self,
        client: Elasticsearch,
        year: int = None,
        month: int = None,
        repo_name_prefix: str = "deepfreeze",
        bucket_name_prefix: str = "deepfreeze",
        base_path_prefix: str = "snapshots",
        canned_acl: str = "private",
        storage_class: str = "intelligent_tiering",
        provider: str = "aws",
        rotate_by: str = "path",
        style: str = "oneup",
        ilm_policy_name: str = None,
        index_template_name: str = None,
        create_data_stream_template: bool = False,
        porcelain: bool = False,
        audit: AuditLogger = None,
        **kwargs,  # Accept extra kwargs for compatibility with curator CLI
    ) -> None:
        self.loggit = logging.getLogger("deepfreeze.actions.setup")
        self.loggit.debug("Initializing Deepfreeze Setup")

        # Console for STDERR output
        self.console = Console(stderr=True)

        self.client = client
        self.porcelain = porcelain
        self.audit = audit
        self.year = year
        self.month = month
        self.settings = Settings(
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
        )
        # Keep direct references for convenience
        self.ilm_policy_name = ilm_policy_name
        self.index_template_name = index_template_name
        self.create_data_stream_template = create_data_stream_template
        self.base_path = self.settings.base_path_prefix

        self.s3 = s3_client_factory(self.settings.provider)

        self.suffix = "000001"
        if self.settings.style != "oneup":
            self.suffix = f"{self.year:04}.{self.month:02}"
        self.settings.last_suffix = self.suffix

        self.new_repo_name = f"{self.settings.repo_name_prefix}-{self.suffix}"
        if self.settings.rotate_by == "bucket":
            self.new_bucket_name = f"{self.settings.bucket_name_prefix}-{self.suffix}"
            self.base_path = f"{self.settings.base_path_prefix}"
        else:
            self.new_bucket_name = f"{self.settings.bucket_name_prefix}"
            self.base_path = f"{self.base_path}-{self.suffix}"

        # Tracks whether *this* run created the bucket, so a later failure
        # (e.g. ES cannot verify the repo) can roll it back instead of
        # orphaning an empty bucket.
        self._bucket_created_this_run = False

        self.loggit.debug("Deepfreeze Setup initialized")

    def _check_preconditions(self) -> None:
        """
        Check preconditions before performing setup. Raise exceptions if any
        preconditions are not met. If this completes without raising an exception,
        the setup can proceed.

        :raises PreconditionError: If any preconditions are not met.

        :return: None
        :rtype: None
        """
        errors = []

        # First, make sure the status index does not exist yet
        self.loggit.debug("Checking if status index %s exists", STATUS_INDEX)
        if self.client.indices.exists(index=STATUS_INDEX):
            errors.append(
                {
                    "issue": f"Status index [cyan]{STATUS_INDEX}[/cyan] already exists",
                    "solution": f"Delete the existing index using the Elasticsearch API:\n"
                    f"  [yellow]curl -X DELETE 'https://<host>:9200/{STATUS_INDEX}'[/yellow]\n\n"
                    "Or via Kibana Dev Tools:\n"
                    f"  [yellow]DELETE /{STATUS_INDEX}[/yellow]",
                }
            )

        # Second, see if any existing repositories match the prefix
        self.loggit.debug(
            "Checking if any existing repositories match %s",
            self.settings.repo_name_prefix,
        )
        repos = self.client.snapshot.get_repository(name="_all")
        self.loggit.debug("Existing repositories: %s", repos)
        matching_repos = [
            repo
            for repo in repos.keys()
            if repo.startswith(self.settings.repo_name_prefix)
        ]

        if matching_repos:
            repo_list = "\n  ".join([f"[cyan]{repo}[/cyan]" for repo in matching_repos])
            delete_cmds = "\n  ".join(
                [f"[yellow]curl -X DELETE 'https://<host>:9200/_snapshot/{repo}'[/yellow]" for repo in matching_repos]
            )
            errors.append(
                {
                    "issue": f"Found {len(matching_repos)} existing repositor{'y' if len(matching_repos) == 1 else 'ies'} matching prefix [cyan]{self.settings.repo_name_prefix}[/cyan]:\n  {repo_list}",
                    "solution": "Delete the existing repositories before running setup:\n"
                    f"  {delete_cmds}\n\n"
                    "Or via Kibana Dev Tools:\n"
                    f"  [yellow]DELETE /_snapshot/{self.settings.repo_name_prefix}-*[/yellow]\n"
                    "\n[bold]WARNING:[/bold] Ensure you have backups before deleting repositories!",
                }
            )

        # Third, check if the bucket already exists
        self.loggit.debug("Checking if bucket %s exists", self.new_bucket_name)
        if self.s3.bucket_exists(self.new_bucket_name):
            storage_type = self.s3.STORAGE_TYPE
            delete_cmd = self.s3.STORAGE_DELETE_CMD.format(bucket=self.new_bucket_name)
            errors.append(
                {
                    "issue": f"{storage_type} [cyan]{self.new_bucket_name}[/cyan] already exists",
                    "solution": f"Delete the existing {storage_type.lower()} before running setup:\n"
                    f"  [yellow]{delete_cmd}[/yellow]\n"
                    "\n[bold]WARNING:[/bold] This will delete all data in the bucket!\n"
                    "Or use a different bucket_name_prefix in your configuration.",
                }
            )

        # Fourth, check if the index template exists
        self.loggit.debug(
            "Checking if index template %s exists", self.index_template_name
        )
        template_exists = False
        template_type = None

        # Check composable templates first (ES 7.8+)
        try:
            templates = self.client.indices.get_index_template(
                name=self.index_template_name
            )
            if (
                templates
                and "index_templates" in templates
                and len(templates["index_templates"]) > 0
            ):
                template_exists = True
                template_type = "composable"
                self.loggit.debug(
                    "Found composable template %s", self.index_template_name
                )
        except Exception:
            pass  # Template not found as composable, try legacy

        # Check legacy templates if not found as composable
        if not template_exists:
            try:
                templates = self.client.indices.get_template(
                    name=self.index_template_name
                )
                if templates and self.index_template_name in templates:
                    template_exists = True
                    template_type = "legacy"
                    self.loggit.debug(
                        "Found legacy template %s", self.index_template_name
                    )
            except Exception:
                pass  # Template not found

        if not template_exists and self.create_data_stream_template:
            # Caller opted to have setup create a minimal data-stream template
            # (do_action handles it); don't treat its absence as a blocker.
            self.loggit.info(
                "Index template %s missing; will create a minimal data-stream "
                "template (--create-data-stream-template)",
                self.index_template_name,
            )
        elif not template_exists:
            errors.append(
                {
                    "issue": f"Index template [cyan]{self.index_template_name}[/cyan] does not exist",
                    "solution": "Create the index template before running setup:\n"
                    f"  [yellow]PUT _index_template/{self.index_template_name}[/yellow]\n"
                    "  with appropriate index_patterns, mappings, and settings.\n\n"
                    "Example:\n"
                    "  [yellow]curl -X PUT 'http://<host>:9200/_index_template/"
                    f"{self.index_template_name}' -H 'Content-Type: application/json' -d '[/yellow]\n"
                    '  [yellow]{"index_patterns": ["your-data-*"], "template": {"settings": {}}}\'[/yellow]',
                }
            )
        else:
            self.loggit.info(
                "Index template %s exists (type: %s)",
                self.index_template_name,
                template_type,
            )

        # Fifth, check for repository plugin based on provider
        # NOTE: Elasticsearch 8.x+ has built-in repository support for all providers
        # Get plugin info from the storage client class
        plugin_name = self.s3.ES_PLUGIN_NAME
        plugin_display = self.s3.ES_PLUGIN_DISPLAY_NAME
        doc_url = self.s3.ES_PLUGIN_DOC_URL

        self.loggit.debug("Checking %s repository support", plugin_display)
        try:
            # Get Elasticsearch version
            cluster_info = self.client.info()
            es_version = cluster_info.get("version", {}).get("number", "0.0.0")
            major_version = int(es_version.split(".")[0])

            if major_version < 8:
                # ES 7.x and below require repository plugins
                self.loggit.debug(
                    "Elasticsearch %s detected - checking for %s repository plugin",
                    es_version,
                    plugin_display,
                )

                # Get cluster plugins
                nodes_info = self.client.nodes.info(node_id="_all", metric="plugins")

                # Check if any node has the required plugin
                has_plugin = False
                for node_id, node_data in nodes_info.get("nodes", {}).items():
                    plugins = node_data.get("plugins", [])
                    for plugin in plugins:
                        if plugin.get("name") == plugin_name:
                            has_plugin = True
                            self.loggit.debug(
                                "Found %s plugin on node %s", plugin_name, node_id
                            )
                            break
                    if has_plugin:
                        break

                if not has_plugin:
                    errors.append(
                        {
                            "issue": f"Elasticsearch {plugin_display} repository plugin is not installed",
                            "solution": f"Install the {plugin_display} repository plugin on all Elasticsearch nodes:\n"
                            f"  [yellow]bin/elasticsearch-plugin install {plugin_name}[/yellow]\n"
                            "  Then restart all Elasticsearch nodes.\n"
                            f"  See: {doc_url}",
                        }
                    )
                else:
                    self.loggit.debug(
                        "%s repository plugin is installed", plugin_display
                    )
            else:
                # ES 8.x+ has built-in repository support
                self.loggit.debug(
                    "Elasticsearch %s detected - %s repository support is built-in",
                    es_version,
                    plugin_display,
                )
        except Exception as e:
            self.loggit.warning(
                "Could not verify %s repository support: %s", plugin_display, e
            )
            # Don't add to errors - this is a soft check that may fail due to permissions

        # If any errors were found, display them all and raise exception
        if errors:
            if self.porcelain:
                # Machine-readable output: tab-separated values
                for error in errors:
                    # Extract clean text from rich markup
                    issue_text = (
                        error["issue"]
                        .replace("[cyan]", "")
                        .replace("[/cyan]", "")
                        .replace("[yellow]", "")
                        .replace("[/yellow]", "")
                        .replace("[bold]", "")
                        .replace("[/bold]", "")
                        .replace("\n", " ")
                    )
                    print(f"ERROR\tprecondition\t{issue_text}")
            else:
                self.console.print(
                    "\n[bold red]Setup Preconditions Failed[/bold red]\n", style="bold"
                )

                for i, error in enumerate(errors, 1):
                    self.console.print(
                        Panel(
                            f"[bold]Issue:[/bold]\n{error['issue']}\n\n"
                            f"[bold]Solution:[/bold]\n{error['solution']}",
                            title=f"[bold red]Error {i} of {len(errors)}[/bold red]",
                            border_style="red",
                            expand=False,
                        )
                    )
                    self.console.print()  # Add spacing between panels

                # Create summary error message
                summary = f"Found {len(errors)} precondition error{'s' if len(errors) > 1 else ''} that must be resolved before setup can proceed."
                self.console.print(
                    Panel(
                        f"[bold]{summary}[/bold]\n\n"
                        "Deepfreeze setup requires a clean environment. Please resolve the issues above and try again.",
                        title="[bold red]Setup Cannot Continue[/bold red]",
                        border_style="red",
                        expand=False,
                    )
                )

            # Build plain-text issue list for programmatic consumers
            def _strip_markup(text: str) -> str:
                import re
                return re.sub(r"\[/?[a-z_ ]+\]", "", text).replace("\n", " ").strip()

            issue_texts = [_strip_markup(e["issue"]) for e in errors]
            summary = f"Found {len(errors)} precondition error{'s' if len(errors) > 1 else ''}: {'; '.join(issue_texts)}"
            raise PreconditionError(summary, issues=issue_texts)

    @staticmethod
    def _looks_like_storage_auth_error(exc: Exception) -> bool:
        """Heuristic: does this exception indicate ES couldn't authenticate to
        (or verify access to) the storage repository?

        These come back from ``snapshot.create_repository`` (verify=true) when
        the Elasticsearch keystore's storage credentials are missing/invalid/
        stale, e.g. ``repository_verification_exception`` /
        ``Invalid JWT Signature`` / ``AccessDenied`` / 401/403.
        """
        text = str(exc).lower()
        markers = (
            "repository_verification_exception",
            "is not accessible on master node",
            "invalid jwt",
            "invalid_grant",
            "access_token",
            "accessdenied",
            "access denied",
            "403 forbidden",
            "401 unauthorized",
            "s_a_s",  # azure SAS
            "signaturedoesnotmatch",
            "invalidaccesskeyid",
        )
        return any(m in text for m in markers)

    def _rollback_bucket(self) -> str:
        """Delete the bucket/container this run created (best effort).

        Called when repository creation/verification fails so we don't leave an
        orphaned empty bucket behind. Returns a human-readable status note (or
        empty string if there was nothing to roll back).
        """
        if not self._bucket_created_this_run:
            return ""
        try:
            self.s3.delete_bucket(self.new_bucket_name, force=True)
            self._bucket_created_this_run = False
            self.loggit.info(
                "Rolled back bucket %s after repository failure", self.new_bucket_name
            )
            return f"deleted the bucket [cyan]{self.new_bucket_name}[/cyan] this run created"
        except Exception as e:  # noqa: BLE001 - rollback is best-effort
            self.loggit.warning(
                "Failed to roll back bucket %s: %s", self.new_bucket_name, e
            )
            return (
                f"could NOT auto-delete bucket [cyan]{self.new_bucket_name}[/cyan] "
                f"({escape(str(e))}); remove it manually"
            )

    def _verify_end_state(self) -> list:
        """Validate that setup actually produced a usable end state.

        Returns a list of failure strings (empty == fully valid). Run before
        declaring success so we never report success on a half-built state
        (e.g. settings written but no repository doc, or a registered repo ES
        can't actually reach).
        """
        from deepfreeze_core.utilities import get_repository, get_settings

        failures = []

        # Make freshly-written status docs searchable before reading them.
        # Elasticsearch search is near-real-time: without this refresh, the
        # repository/settings docs that create_repo/save_settings just wrote may
        # not yet be visible to the searches below, producing false negatives
        # (e.g. "repository doc mismatch (bucket=None)").
        try:
            self.client.indices.refresh(index=STATUS_INDEX)
        except Exception:  # noqa: BLE001 - refresh is best-effort
            pass

        # 1. ES snapshot repo registered AND reachable (real ES->storage check).
        try:
            repos = self.client.snapshot.get_repository(name=self.new_repo_name)
            if self.new_repo_name not in repos:
                failures.append(f"snapshot repository '{self.new_repo_name}' is not registered")
            else:
                self.client.snapshot.verify_repository(name=self.new_repo_name)
        except Exception as e:  # noqa: BLE001
            failures.append(f"snapshot repository '{self.new_repo_name}' not verifiable: {e}")

        # 2. status repository doc exists and matches.
        try:
            repo_doc = get_repository(self.client, self.new_repo_name)
            if not repo_doc or repo_doc.name != self.new_repo_name:
                failures.append(f"status index has no repository doc for '{self.new_repo_name}'")
            elif repo_doc.bucket != self.new_bucket_name or repo_doc.base_path != self.base_path:
                failures.append(
                    f"status repository doc mismatch (bucket={repo_doc.bucket}, base_path={repo_doc.base_path})"
                )
        except Exception as e:  # noqa: BLE001
            failures.append(f"could not read status repository doc: {e}")

        # 3. settings doc present.
        try:
            if not get_settings(self.client):
                failures.append("settings document missing from status index")
        except Exception as e:  # noqa: BLE001
            failures.append(f"could not read settings document: {e}")

        # 4. storage bucket reachable.
        try:
            if not self.s3.bucket_exists(self.new_bucket_name):
                failures.append(f"storage bucket '{self.new_bucket_name}' not found")
        except Exception as e:  # noqa: BLE001
            failures.append(f"could not check storage bucket: {e}")

        # 5. ILM policy present (when requested).
        if self.ilm_policy_name:
            try:
                self.client.ilm.get_lifecycle(name=self.ilm_policy_name)
            except Exception:  # noqa: BLE001
                failures.append(f"ILM policy '{self.ilm_policy_name}' not found")

        # 6. index template present + linked to the ILM policy (when requested).
        if self.index_template_name and self.ilm_policy_name:
            try:
                tmpl = self.client.indices.get_index_template(name=self.index_template_name)
                items = tmpl.get("index_templates", [])
                linked = items and (
                    items[0].get("index_template", {})
                    .get("template", {})
                    .get("settings", {})
                    .get("index", {})
                    .get("lifecycle", {})
                    .get("name")
                    == self.ilm_policy_name
                )
                if not linked:
                    failures.append(
                        f"index template '{self.index_template_name}' is not linked to ILM policy '{self.ilm_policy_name}'"
                    )
            except Exception as e:  # noqa: BLE001
                failures.append(f"could not verify index template: {e}")

        return failures

    def do_dry_run(self) -> None:
        """
        Perform a dry-run of the setup process.

        :return: None
        :rtype: None
        """
        self.loggit.info("DRY-RUN MODE.  No changes will be made.")
        msg = f"DRY-RUN: deepfreeze setup of {self.new_repo_name} backed by {self.new_bucket_name}, with base path {self.base_path}."
        self.loggit.info(msg)

        # Initialize audit tracking
        tracker = None
        if self.audit:
            tracker = self.audit.start_tracking(
                action="setup",
                dry_run=True,
                parameters={
                    "repo_name_prefix": self.settings.repo_name_prefix,
                    "bucket_name_prefix": self.settings.bucket_name_prefix,
                    "ilm_policy_name": self.ilm_policy_name,
                    "index_template_name": self.index_template_name,
                },
            )

        try:
            self._check_preconditions()

            # Record what would be created
            if tracker:
                tracker.add_result({"type": "settings_index", "action": "would_create"})
                tracker.add_result(
                    {
                        "type": "bucket",
                        "name": self.new_bucket_name,
                        "action": "would_create",
                    }
                )
                tracker.add_result(
                    {
                        "type": "repository",
                        "name": self.new_repo_name,
                        "bucket": self.new_bucket_name,
                        "base_path": self.base_path,
                        "action": "would_create",
                    }
                )
                if self.ilm_policy_name:
                    tracker.add_result(
                        {
                            "type": "ilm_policy",
                            "name": self.ilm_policy_name,
                            "action": "would_create_or_update",
                        }
                    )
                if self.index_template_name:
                    tracker.add_result(
                        {
                            "type": "index_template",
                            "name": self.index_template_name,
                            "action": "would_update",
                        }
                    )
                tracker.set_summary(
                    {
                        "would_create_repository": self.new_repo_name,
                        "would_create_bucket": self.new_bucket_name,
                        "would_create_base_path": self.base_path,
                    }
                )

            self.loggit.info("DRY-RUN: Creating bucket %s", self.new_bucket_name)
            create_repo(
                self.client,
                self.new_repo_name,
                self.new_bucket_name,
                self.base_path,
                self.settings.canned_acl,
                self.settings.storage_class,
                provider=self.settings.provider,
                dry_run=True,
            )
        except Exception as e:
            if tracker:
                tracker.add_error({"code": type(e).__name__, "message": str(e)})
            raise
        finally:
            if self.audit and tracker:
                self.audit.commit(tracker)

    def do_action(self) -> None:
        """
        Perform setup steps to create initial bucket and repository and save settings.

        :return: None
        :rtype: None
        """
        self.loggit.debug("Starting Setup action")

        # Initialize audit tracking
        tracker = None
        if self.audit:
            tracker = self.audit.start_tracking(
                action="setup",
                dry_run=False,
                parameters={
                    "repo_name_prefix": self.settings.repo_name_prefix,
                    "bucket_name_prefix": self.settings.bucket_name_prefix,
                    "ilm_policy_name": self.ilm_policy_name,
                    "index_template_name": self.index_template_name,
                },
            )

        try:
            # Check preconditions
            self._check_preconditions()

            # Create audit index alongside status index (for future use)
            if self.audit:
                self.audit.ensure_audit_index()
                if tracker:
                    tracker.add_result({"type": "audit_index", "action": "created"})
            else:
                # Even without audit logger, ensure the index exists for future use
                from deepfreeze_core.audit import ensure_audit_index

                ensure_audit_index(self.client)
                if tracker:
                    tracker.add_result({"type": "audit_index", "action": "created"})

            # Create settings index and save settings
            self.loggit.info("Creating settings index and saving configuration")
            try:
                ensure_settings_index(self.client, create_if_missing=True)
                save_settings(self.client, self.settings)
                if tracker:
                    tracker.add_result({"type": "settings_index", "action": "created"})
            except Exception as e:
                if self.porcelain:
                    print(f"ERROR\tsettings_index\t{str(e)}")
                else:
                    self.console.print(
                        Panel(
                            f"[bold]Failed to create settings index or save configuration[/bold]\n\n"
                            f"Error: {escape(str(e))}\n\n"
                            f"[bold]Possible Solutions:[/bold]\n"
                            f"  - Check Elasticsearch connection and permissions\n"
                            f"  - Verify the cluster is healthy and has capacity\n"
                            f"  - Check Elasticsearch logs for details",
                            title="[bold red]Settings Index Error[/bold red]",
                            border_style="red",
                            expand=False,
                        )
                    )
                raise

            # Create S3 bucket
            # ENHANCED LOGGING: Log bucket creation parameters
            self.loggit.info(
                "Creating S3 bucket %s with ACL=%s, storage_class=%s",
                self.new_bucket_name,
                self.settings.canned_acl,
                self.settings.storage_class,
            )
            self.loggit.debug(
                "Full bucket creation parameters: bucket=%s, ACL=%s, storage_class=%s, provider=%s",
                self.new_bucket_name,
                self.settings.canned_acl,
                self.settings.storage_class,
                self.settings.provider,
            )
            try:
                self.s3.create_bucket(self.new_bucket_name)
                self._bucket_created_this_run = True
                self.loggit.info(
                    "Successfully created S3 bucket %s", self.new_bucket_name
                )
                if tracker:
                    tracker.add_result(
                        {
                            "type": "bucket",
                            "name": self.new_bucket_name,
                            "action": "created",
                        }
                    )
            except Exception as e:
                if self.porcelain:
                    print(f"ERROR\tstorage\t{self.new_bucket_name}\t{str(e)}")
                else:
                    # Get provider-specific error info from the storage client
                    storage_type = self.s3.STORAGE_TYPE
                    solutions = self.s3.STORAGE_CREATION_HELP

                    self.console.print(
                        Panel(
                            f"[bold]Failed to create {storage_type} [cyan]{self.new_bucket_name}[/cyan][/bold]\n\n"
                            f"Error: {escape(str(e))}\n\n"
                            f"[bold]{solutions}[/bold]",
                            title=f"[bold red]{storage_type.title()} Creation Error[/bold red]",
                            border_style="red",
                            expand=False,
                        )
                    )
                raise

            # Create repository
            # ENHANCED LOGGING: Log repository configuration
            self.loggit.info("Creating repository %s", self.new_repo_name)
            self.loggit.debug(
                "Repository configuration: name=%s, bucket=%s, base_path=%s, ACL=%s, storage_class=%s",
                self.new_repo_name,
                self.new_bucket_name,
                self.base_path,
                self.settings.canned_acl,
                self.settings.storage_class,
            )
            try:
                create_repo(
                    self.client,
                    self.new_repo_name,
                    self.new_bucket_name,
                    self.base_path,
                    self.settings.canned_acl,
                    self.settings.storage_class,
                    provider=self.settings.provider,
                )
                self.loggit.info(
                    "Successfully created repository %s", self.new_repo_name
                )
                if tracker:
                    tracker.add_result(
                        {
                            "type": "repository",
                            "name": self.new_repo_name,
                            "bucket": self.new_bucket_name,
                            "base_path": self.base_path,
                            "action": "created",
                        }
                    )
            except Exception as e:
                # ES registers + verifies the repo using ITS OWN keystore
                # credentials (gcs.client.* / s3.client.* / azure.client.*),
                # which are separate from the CLI's config.yml creds. A
                # verification failure here almost always means those keystore
                # creds are missing/invalid/out of sync with the operator key.
                is_auth = self._looks_like_storage_auth_error(e)
                # Roll back the bucket we just created so we don't orphan it.
                rollback_note = self._rollback_bucket()

                if self.porcelain:
                    kind = "es_storage_auth" if is_auth else "repository"
                    print(f"ERROR\t{kind}\t{self.new_repo_name}\t{str(e)}")
                    if rollback_note:
                        print(f"ROLLBACK\tbucket\t{self.new_bucket_name}\t{rollback_note}")
                else:
                    storage_type = self.s3.STORAGE_TYPE
                    keystore_instructions = self.s3.ES_KEYSTORE_INSTRUCTIONS
                    doc_url = self.s3.ES_PLUGIN_DOC_URL
                    plugin_name = self.s3.ES_PLUGIN_NAME
                    plugin_display = self.s3.ES_PLUGIN_DISPLAY_NAME

                    if is_auth:
                        title = "Elasticsearch Cannot Access the Repository"
                        solutions = (
                            f"Elasticsearch could not access {storage_type} "
                            f"[cyan]{self.new_bucket_name}[/cyan] for repository "
                            f"[cyan]{self.new_repo_name}[/cyan].\n\n"
                            "This is an [bold]Elasticsearch keystore credential[/bold] problem, "
                            "[bold]not[/bold] your CLI/config.yml credentials (those just created "
                            "the bucket successfully). ES uses its own stored credentials to "
                            "read/write the snapshot repository, and they are missing, invalid, "
                            "or out of sync with the current key.\n\n"
                            f"[bold]Fix:[/bold] {keystore_instructions}\n\n"
                            f"[bold]Docs:[/bold] {doc_url}"
                        )
                    else:
                        title = "Repository Creation Error"
                        solutions = (
                            f"[bold]Possible Solutions:[/bold]\n"
                            f"  1. Install the {plugin_display} repository plugin on all Elasticsearch nodes:\n"
                            f"     [yellow]bin/elasticsearch-plugin install {plugin_name}[/yellow]\n\n"
                            f"  2. {keystore_instructions}\n\n"
                            f"  3. Verify {storage_type} [cyan]{self.new_bucket_name}[/cyan] is accessible\n\n"
                            f"[bold]Documentation:[/bold]\n"
                            f"  {doc_url}"
                        )

                    rollback_line = f"\n\n[bold]Rollback:[/bold] {rollback_note}" if rollback_note else ""
                    self.console.print(
                        Panel(
                            f"[bold]Failed to create repository [cyan]{self.new_repo_name}[/cyan][/bold]\n\n"
                            f"Error: {escape(str(e))}\n\n"
                            f"{solutions}{rollback_line}",
                            title=f"[bold red]{title}[/bold red]",
                            border_style="red",
                            expand=False,
                        )
                    )
                raise

            # Optionally create a minimal data-stream index template when it is
            # missing and the caller opted in. The data template is normally the
            # user's own (defining their mappings); this opt-in keeps
            # reset -> setup self-contained for dev/test. The later ILM-link step
            # then attaches the policy to it.
            if self.create_data_stream_template and self.index_template_name and (
                not self.client.indices.exists_index_template(name=self.index_template_name)
            ):
                try:
                    self.client.indices.put_index_template(
                        name=self.index_template_name,
                        body={
                            "index_patterns": [self.index_template_name],
                            "data_stream": {},
                            "template": {
                                "mappings": {"properties": {"@timestamp": {"type": "date"}}}
                            },
                        },
                    )
                    self.loggit.info(
                        "Created minimal data-stream template %s", self.index_template_name
                    )
                    if tracker:
                        tracker.add_result(
                            {
                                "type": "index_template",
                                "name": self.index_template_name,
                                "action": "created",
                            }
                        )
                    if self.porcelain:
                        print(f"INDEX_TEMPLATE\t{self.index_template_name}\tcreated")
                    else:
                        self.console.print(
                            Panel(
                                f"[bold green]Created data-stream template [cyan]{self.index_template_name}[/cyan][/bold green]\n\n"
                                f"index_patterns: [[cyan]{self.index_template_name}[/cyan]], data_stream enabled, @timestamp:date.",
                                title="[bold green]Index Template Created[/bold green]",
                                border_style="green",
                                expand=False,
                            )
                        )
                except Exception as e:  # noqa: BLE001 - non-fatal; ILM-link step warns
                    self.loggit.warning("Failed to create data-stream template: %s", e)
                    if self.porcelain:
                        print(f"WARNING\tindex_template\t{self.index_template_name}\t{str(e)}")
                    else:
                        self.console.print(
                            Panel(
                                f"[bold yellow]Could not create data-stream template [cyan]{self.index_template_name}[/cyan][/bold yellow]\n\n"
                                f"Error: {escape(str(e))}",
                                title="[bold yellow]Index Template Warning[/bold yellow]",
                                border_style="yellow",
                                expand=False,
                            )
                        )

            # Variables to track ILM and template results
            ilm_result = None
            template_result = None

            # Create or update ILM policy if specified
            if self.ilm_policy_name:
                self.loggit.info("Processing ILM policy %s", self.ilm_policy_name)
                try:
                    ilm_result = create_or_update_ilm_policy(
                        client=self.client,
                        policy_name=self.ilm_policy_name,
                        repo_name=self.new_repo_name,
                    )
                    if self.porcelain:
                        print(
                            f"ILM_POLICY\t{self.ilm_policy_name}\t{ilm_result['action']}"
                        )
                    else:
                        if ilm_result["action"] == "created":
                            self.console.print(
                                Panel(
                                    f"[bold green]Created ILM policy [cyan]{self.ilm_policy_name}[/cyan][/bold green]\n\n"
                                    f"Policy configuration:\n"
                                    f"  - Hot: 7 days (rollover at 45GB or 7d)\n"
                                    f"  - Cold: 30 days\n"
                                    f"  - Frozen: 365 days (snapshot to [cyan]{self.new_repo_name}[/cyan])\n"
                                    f"  - Delete: after frozen (delete_searchable_snapshot=false)",
                                    title="[bold green]ILM Policy Created[/bold green]",
                                    border_style="green",
                                    expand=False,
                                )
                            )
                        elif ilm_result["action"] == "updated":
                            self.console.print(
                                Panel(
                                    f"[bold blue]Updated ILM policy [cyan]{self.ilm_policy_name}[/cyan][/bold blue]\n\n"
                                    f"- Updated searchable_snapshot repository to [cyan]{self.new_repo_name}[/cyan]\n"
                                    f"- Ensured delete_searchable_snapshot=false in delete phase",
                                    title="[bold blue]ILM Policy Updated[/bold blue]",
                                    border_style="blue",
                                    expand=False,
                                )
                            )
                        else:  # unchanged
                            self.console.print(
                                Panel(
                                    f"[bold yellow]ILM policy [cyan]{self.ilm_policy_name}[/cyan] unchanged[/bold yellow]\n\n"
                                    f"No searchable_snapshot actions found to update.",
                                    title="[bold yellow]ILM Policy Unchanged[/bold yellow]",
                                    border_style="yellow",
                                    expand=False,
                                )
                            )
                except Exception as e:
                    # ILM policy management failed
                    if self.porcelain:
                        print(f"WARNING\tilm_policy\t{self.ilm_policy_name}\t{str(e)}")
                    else:
                        self.console.print(
                            Panel(
                                f"[bold yellow]Warning: Failed to manage ILM policy[/bold yellow]\n\n"
                                f"Error: {escape(str(e))}\n\n"
                                f"Setup will continue, but you may need to configure the ILM policy manually.",
                                title="[bold yellow]ILM Policy Warning[/bold yellow]",
                                border_style="yellow",
                                expand=False,
                            )
                        )
                    self.loggit.warning("Failed to manage ILM policy: %s", e)

            # Update index template if specified (CLI validates that ilm_policy_name is also set)
            if self.index_template_name:
                self.loggit.info("Updating index template %s", self.index_template_name)
                try:
                    template_result = update_index_template_ilm_policy(
                        client=self.client,
                        template_name=self.index_template_name,
                        ilm_policy_name=self.ilm_policy_name,
                    )
                    if self.porcelain:
                        print(
                            f"INDEX_TEMPLATE\t{self.index_template_name}\t{template_result['action']}"
                        )
                    else:
                        if template_result["action"] == "updated":
                            old_policy = template_result.get("old_policy", "none")
                            self.console.print(
                                Panel(
                                    f"[bold green]Updated index template [cyan]{self.index_template_name}[/cyan][/bold green]\n\n"
                                    f"Template type: {template_result.get('template_type', 'unknown')}\n"
                                    f"ILM policy: [yellow]{old_policy}[/yellow] -> [cyan]{self.ilm_policy_name}[/cyan]",
                                    title="[bold green]Index Template Updated[/bold green]",
                                    border_style="green",
                                    expand=False,
                                )
                            )
                        elif template_result["action"] == "not_found":
                            self.console.print(
                                Panel(
                                    f"[bold yellow]Index template [cyan]{self.index_template_name}[/cyan] not found[/bold yellow]\n\n"
                                    f"Checked both composable and legacy templates.\n"
                                    f"The ILM policy was still created/updated, but you'll need to\n"
                                    f"create the index template manually or specify an existing template name.",
                                    title="[bold yellow]Index Template Not Found[/bold yellow]",
                                    border_style="yellow",
                                    expand=False,
                                )
                            )
                except Exception as e:
                    if self.porcelain:
                        print(
                            f"WARNING\tindex_template\t{self.index_template_name}\t{str(e)}"
                        )
                    else:
                        self.console.print(
                            Panel(
                                f"[bold yellow]Warning: Failed to update index template[/bold yellow]\n\n"
                                f"Error: {escape(str(e))}\n\n"
                                f"The ILM policy was configured, but you may need to update\n"
                                f"the index template manually.",
                                title="[bold yellow]Index Template Warning[/bold yellow]",
                                border_style="yellow",
                                expand=False,
                            )
                        )
                    self.loggit.warning("Failed to update index template: %s", e)

            # Validate the end state before declaring success, so we never
            # report success on a half-built result.
            validation_failures = self._verify_end_state()
            if validation_failures:
                if tracker:
                    for vf in validation_failures:
                        tracker.add_error({"code": "POST_SETUP_VALIDATION", "message": vf})
                if self.porcelain:
                    for vf in validation_failures:
                        print(f"VALIDATION_FAILED\t{vf}")
                else:
                    bullets = "\n".join(f"  - {escape(vf)}" for vf in validation_failures)
                    self.console.print(
                        Panel(
                            "[bold]Setup ran, but the end state is incomplete — NOT declaring success.[/bold]\n\n"
                            f"{bullets}\n\n"
                            "Resolve the above, then run [yellow]deepfreeze cleanup[/yellow] and re-run setup "
                            "before relying on this repository.",
                            title="[bold red]Post-Setup Validation Failed[/bold red]",
                            border_style="red",
                            expand=False,
                        )
                    )
                raise ActionError(
                    "post-setup validation failed: " + "; ".join(validation_failures)
                )

            # Success!
            if tracker:
                tracker.set_summary(
                    {
                        "repository": self.new_repo_name,
                        "bucket": self.new_bucket_name,
                        "base_path": self.base_path,
                    }
                )

            if self.porcelain:
                # Machine-readable output: tab-separated values
                # Format: SUCCESS\t{repo_name}\t{bucket_name}\t{base_path}
                print(
                    f"SUCCESS\t{self.new_repo_name}\t{self.new_bucket_name}\t{self.base_path}"
                )
            else:
                # Build summary message with what was configured
                summary_lines = [
                    "[bold green]Setup completed successfully![/bold green]\n",
                    f"Repository: [cyan]{self.new_repo_name}[/cyan]",
                    f"S3 Bucket: [cyan]{self.new_bucket_name}[/cyan]",
                    f"Base Path: [cyan]{escape(self.base_path)}[/cyan]",
                ]

                # Add ILM policy info if configured
                if ilm_result:
                    policy_status = ilm_result["action"]
                    summary_lines.append(
                        f"ILM Policy: [cyan]{self.ilm_policy_name}[/cyan] ({policy_status})"
                    )

                # Add template info if configured
                if template_result and template_result.get("action") == "updated":
                    summary_lines.append(
                        f"Index Template: [cyan]{self.index_template_name}[/cyan] (updated)"
                    )

                summary_lines.append("")  # Empty line before next steps

                # Determine next steps based on what was configured
                if (
                    self.ilm_policy_name
                    and self.index_template_name
                    and template_result
                    and template_result.get("action") == "updated"
                ):
                    # Fully configured - minimal next steps
                    summary_lines.extend(
                        [
                            "[bold]Next Steps:[/bold]",
                            "  1. Your data flow is configured! New indices matching template",
                            f"     [cyan]{self.index_template_name}[/cyan] will use the ILM policy",
                            "  2. Existing indices may need manual ILM policy assignment",
                            "  3. Run [yellow]deepfreeze status[/yellow] to verify setup",
                        ]
                    )
                elif self.ilm_policy_name:
                    # ILM policy configured but template not updated
                    summary_lines.extend(
                        [
                            "[bold]Next Steps:[/bold]",
                            f"  1. Attach ILM policy [cyan]{self.ilm_policy_name}[/cyan] to your index templates",
                            "  2. Or assign directly to indices with:",
                            "     [yellow]PUT /your-index/_settings[/yellow]",
                            f"     [yellow]{{'index.lifecycle.name': '{self.ilm_policy_name}'}}[/yellow]",
                        ]
                    )
                else:
                    # No ILM configuration - manual steps needed
                    summary_lines.extend(
                        [
                            "[bold]Next Steps:[/bold]",
                            f"  1. Create or update ILM policies to use repository [cyan]{self.new_repo_name}[/cyan]",
                            "  2. Ensure delete phase has [yellow]delete_searchable_snapshot: false[/yellow]",
                            "  3. Attach the ILM policy to your index templates",
                            "  4. Or re-run setup with [yellow]--ilm_policy_name[/yellow] and [yellow]--index_template_name[/yellow]",
                        ]
                    )

                self.console.print(
                    Panel(
                        "\n".join(summary_lines),
                        title="[bold green]Deepfreeze Setup Complete[/bold green]",
                        border_style="green",
                        expand=False,
                    )
                )

            self.loggit.info(
                "Setup complete. Repository %s is ready to use.", self.new_repo_name
            )

        except PreconditionError:
            # Precondition errors are already formatted and displayed, just re-raise
            if tracker:
                tracker.add_error(
                    {
                        "code": "PRECONDITION_ERROR",
                        "message": "Precondition check failed",
                    }
                )
            raise
        except ActionError as e:
            # Already-displayed errors (bucket/repo failure with rollback,
            # post-setup validation). Re-raise without the generic panel.
            if tracker:
                tracker.add_error({"code": "ACTION_ERROR", "message": str(e)})
            raise
        except Exception as e:
            # Catch any unexpected errors
            if tracker:
                tracker.add_error({"code": "UNEXPECTED_ERROR", "message": str(e)})
            if self.porcelain:
                print(f"ERROR\tunexpected\t{str(e)}")
            else:
                provider_name = self.s3.ES_PLUGIN_DISPLAY_NAME
                self.console.print(
                    Panel(
                        f"[bold]An unexpected error occurred during setup[/bold]\n\n"
                        f"Error: {escape(str(e))}\n\n"
                        f"[bold]What to do:[/bold]\n"
                        f"  - Check the logs for detailed error information\n"
                        f"  - Verify all prerequisites are met ({provider_name} credentials, ES connection, etc.)\n"
                        f"  - You may need to manually clean up any partially created resources\n"
                        f"  - Run [yellow]deepfreeze cleanup[/yellow] to remove any partial state",
                        title="[bold red]Unexpected Setup Error[/bold red]",
                        border_style="red",
                        expand=False,
                    )
                )
            self.loggit.error("Unexpected error during setup: %s", e, exc_info=True)
            raise
        finally:
            # Always commit audit log, even on failure
            if self.audit and tracker:
                self.audit.commit(tracker)
