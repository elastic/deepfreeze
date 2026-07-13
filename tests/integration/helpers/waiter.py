"""Condition-based polling with exponential backoff.

All integration tests that check async state (thaw status, job completion,
server readiness) use these utilities instead of hardcoded sleeps.
"""

import logging
import time
from typing import Callable, Optional

import httpx

logger = logging.getLogger("deepfreeze.tests.waiter")


def wait_for(
    condition: Callable[[], bool],
    timeout: float = 300.0,
    initial_interval: float = 2.0,
    max_interval: float = 30.0,
    backoff_factor: float = 1.5,
    description: str = "condition",
    on_timeout: Optional[Callable[[], str]] = None,
) -> None:
    """Poll ``condition()`` until it returns True or timeout expires.

    Uses exponential backoff starting at *initial_interval*, multiplied by
    *backoff_factor* each iteration, capped at *max_interval*.

    Raises ``TimeoutError`` with *description* (and optional diagnostic
    string from *on_timeout*) when the deadline is exceeded.
    """
    deadline = time.monotonic() + timeout
    interval = initial_interval

    while True:
        if condition():
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            diag = ""
            if on_timeout:
                try:
                    diag = f"\nDiagnostics: {on_timeout()}"
                except Exception as exc:
                    diag = f"\n(diagnostic callback failed: {exc})"
            raise TimeoutError(
                f"Timed out waiting for {description} after {timeout}s{diag}"
            )
        sleep_time = min(interval, remaining, max_interval)
        logger.debug("Waiting %.1fs for %s (%.0fs remaining)", sleep_time, description, remaining)
        time.sleep(sleep_time)
        interval = min(interval * backoff_factor, max_interval)


# -- Convenience wrappers --


def wait_for_index_exists(es, index_name: str, timeout: float = 60) -> None:
    """Wait until an ES index exists."""
    wait_for(
        lambda: es.indices.exists(index=index_name),
        timeout=timeout,
        description=f"index '{index_name}' to exist",
    )


def wait_for_thaw_status(es, request_id: str, target_status: str, timeout: float = 600) -> None:
    """Wait until a thaw request reaches *target_status*."""
    from deepfreeze_core.constants import STATUS_INDEX

    def _check():
        try:
            doc = es.get(index=STATUS_INDEX, id=request_id)
            return doc["_source"].get("status") == target_status
        except Exception:
            return False

    wait_for(
        _check,
        timeout=timeout,
        description=f"thaw request '{request_id}' to reach status '{target_status}'",
    )


def wait_for_repo_state(es, repo_name: str, target_state: str, timeout: float = 600) -> None:
    """Wait until a repository's thaw_state matches *target_state*."""
    from deepfreeze_core.constants import STATUS_INDEX

    def _check():
        try:
            result = es.search(
                index=STATUS_INDEX,
                body={"query": {"term": {"name": repo_name}}, "size": 1},
            )
            hits = result.get("hits", {}).get("hits", [])
            if hits:
                return hits[0]["_source"].get("thaw_state") == target_state
        except Exception:
            pass
        return False

    wait_for(
        _check,
        timeout=timeout,
        description=f"repo '{repo_name}' to reach state '{target_state}'",
    )


def wait_for_server_ready(base_url: str, timeout: float = 30) -> None:
    """Wait until the deepfreeze server responds to /health."""

    def _check():
        try:
            resp = httpx.get(f"{base_url}/health", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False

    wait_for(
        _check,
        timeout=timeout,
        initial_interval=0.5,
        description=f"server at {base_url} to be ready",
    )
