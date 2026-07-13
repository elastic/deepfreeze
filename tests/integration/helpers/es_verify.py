"""Elasticsearch state verification helpers.

Assertion functions that query ES directly and provide rich failure
messages.  Used by integration tests to verify that deepfreeze
operations had the expected side effects.
"""

import json
import logging
from typing import Optional

from elasticsearch8 import Elasticsearch, NotFoundError

from deepfreeze_core.constants import STATUS_INDEX

logger = logging.getLogger("deepfreeze.tests.es_verify")


# -- Index assertions --


def assert_index_exists(es: Elasticsearch, index: str) -> None:
    """Assert an ES index exists."""
    assert es.indices.exists(index=index), f"Expected index '{index}' to exist but it does not"


def assert_index_not_exists(es: Elasticsearch, index: str) -> None:
    """Assert an ES index does NOT exist."""
    assert not es.indices.exists(index=index), f"Expected index '{index}' to not exist but it does"


# -- Repository assertions --


def assert_repo_exists(es: Elasticsearch, repo_name: str) -> dict:
    """Assert a snapshot repository exists in ES. Returns the repo settings."""
    try:
        repos = es.snapshot.get_repository(name=repo_name)
        assert repo_name in repos, f"Repository '{repo_name}' not found. Available: {list(repos.keys())}"
        return repos[repo_name]
    except NotFoundError:
        raise AssertionError(f"Repository '{repo_name}' does not exist in Elasticsearch")


def assert_repo_not_exists(es: Elasticsearch, repo_name: str) -> None:
    """Assert a snapshot repository does NOT exist."""
    try:
        repos = es.snapshot.get_repository(name=repo_name)
        assert repo_name not in repos, f"Repository '{repo_name}' exists but shouldn't"
    except NotFoundError:
        pass  # expected


# -- ILM policy assertions --


def assert_ilm_policy_exists(es: Elasticsearch, policy_name: str) -> dict:
    """Assert an ILM policy exists. Returns the policy body."""
    try:
        policies = es.ilm.get_lifecycle(name=policy_name)
        assert policy_name in policies, (
            f"ILM policy '{policy_name}' not found. Available: {list(policies.keys())}"
        )
        return policies[policy_name]
    except NotFoundError:
        raise AssertionError(f"ILM policy '{policy_name}' does not exist")


# -- Settings assertions --


def assert_settings_exist(es: Elasticsearch) -> dict:
    """Assert the deepfreeze settings doc exists in the status index. Returns it."""
    from deepfreeze_core.constants import SETTINGS_ID

    assert es.indices.exists(index=STATUS_INDEX), (
        f"Status index '{STATUS_INDEX}' does not exist — has setup been run?"
    )
    try:
        doc = es.get(index=STATUS_INDEX, id=SETTINGS_ID)
        return doc["_source"]
    except NotFoundError:
        raise AssertionError(
            f"Settings document (id={SETTINGS_ID}) not found in '{STATUS_INDEX}'"
        )


# -- Repository state helpers --


def get_repos_with_prefix(es: Elasticsearch, prefix: str) -> list[dict]:
    """Query deepfreeze-status for repository docs matching *prefix*.

    Refreshes the index first to ensure recently-indexed docs are visible.
    """
    try:
        # Ensure recently written docs are searchable
        es.indices.refresh(index=STATUS_INDEX)

        result = es.search(
            index=STATUS_INDEX,
            body={
                "query": {"bool": {"must": [
                    {"prefix": {"name.keyword": prefix}},
                    {"exists": {"field": "bucket"}},  # repos have a bucket field
                ]}},
                "size": 100,
            },
        )
        return [hit["_source"] for hit in result["hits"]["hits"]]
    except Exception as exc:
        logger.warning("Failed to query repos with prefix '%s': %s", prefix, exc)
        return []


def get_repo_thaw_state(es: Elasticsearch, repo_name: str) -> Optional[str]:
    """Get the current thaw_state of a repository from the status index."""
    try:
        result = es.search(
            index=STATUS_INDEX,
            body={"query": {"term": {"name.keyword": repo_name}}, "size": 1},
        )
        hits = result.get("hits", {}).get("hits", [])
        if hits:
            return hits[0]["_source"].get("thaw_state")
    except Exception as exc:
        logger.warning("Failed to get thaw state for '%s': %s", repo_name, exc)
    return None


def get_thaw_request(es: Elasticsearch, request_id: str) -> Optional[dict]:
    """Get a thaw request document by ID."""
    try:
        doc = es.get(index=STATUS_INDEX, id=request_id)
        return doc["_source"]
    except NotFoundError:
        return None


# -- Full state snapshot for diagnostics --


def snapshot_es_state(es: Elasticsearch, prefix: str) -> dict:
    """Capture a full snapshot of all test-related ES state.

    Useful for failure diagnostics — written to JSON when tests fail.
    """
    state: dict = {"prefix": prefix, "indices": [], "repos": [], "ilm_policies": [], "status_docs": []}

    # Indices
    try:
        indices = es.indices.get(index=f"{prefix}*", ignore_unavailable=True)
        state["indices"] = list(indices.keys()) if indices else []
    except Exception:
        state["indices"] = "error querying"

    # Snapshot repositories
    try:
        repos = es.snapshot.get_repository(name=f"{prefix}*")
        state["repos"] = list(repos.keys())
    except Exception:
        state["repos"] = []

    # ILM policies
    try:
        all_policies = es.ilm.get_lifecycle()
        state["ilm_policies"] = [name for name in all_policies if name.startswith(prefix)]
    except Exception:
        state["ilm_policies"] = "error querying"

    # Status index docs
    try:
        if es.indices.exists(index=STATUS_INDEX):
            result = es.search(
                index=STATUS_INDEX,
                body={"query": {"prefix": {"name.keyword": prefix}}, "size": 50},
            )
            state["status_docs"] = [hit["_source"] for hit in result["hits"]["hits"]]
    except Exception:
        state["status_docs"] = "error querying"

    return state
