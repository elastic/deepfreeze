"""Failure diagnostics — capture ES state snapshots on test failures.

When an integration test fails, this module writes a JSON file with
the full ES state (indices, repos, ILM policies, status docs) to
``tests/integration/.diagnostics/`` for post-mortem analysis.
"""

import json
import logging
import time
from pathlib import Path

from .es_verify import snapshot_es_state

logger = logging.getLogger("deepfreeze.tests.diagnostics")

DIAGNOSTICS_DIR = Path(__file__).parent.parent / ".diagnostics"


def write_failure_diagnostics(
    test_name: str,
    es_client,
    prefix: str,
    extra: dict | None = None,
) -> Path | None:
    """Capture ES state and write to a diagnostics file.

    Returns the path to the file, or None if capture failed.
    """
    try:
        DIAGNOSTICS_DIR.mkdir(exist_ok=True)
        state = snapshot_es_state(es_client, prefix)
        if extra:
            state["extra"] = extra

        timestamp = time.strftime("%Y%m%d_%H%M%S")
        safe_name = test_name.replace("/", "_").replace("::", "__")
        path = DIAGNOSTICS_DIR / f"{safe_name}_{timestamp}.json"
        path.write_text(json.dumps(state, indent=2, default=str))
        logger.info("Diagnostics written to %s", path)
        return path
    except Exception as exc:
        logger.warning("Failed to write diagnostics: %s", exc)
        return None
