"""
Tests for package import verification (Task Group 1)

These tests verify that the deepfreeze package:
1. Can be imported successfully
2. Contains no curator imports
3. Has proper entry point registration
"""

import ast
from pathlib import Path


def test_package_imports_successfully():
    """Test that the deepfreeze package can be imported"""
    import elastic_deepfreeze

    assert elastic_deepfreeze is not None
    assert hasattr(elastic_deepfreeze, "__version__")
    assert len(elastic_deepfreeze.__version__) > 0  # Version should be a non-empty string


def test_submodules_import_successfully():
    """Test that all submodules can be imported"""
    import elastic_deepfreeze.cli
    import elastic_deepfreeze.config
    import elastic_deepfreeze.validators
    import elastic_deepfreeze_core.actions
    import elastic_deepfreeze_core.constants
    import elastic_deepfreeze_core.exceptions

    assert elastic_deepfreeze_core.exceptions is not None
    assert elastic_deepfreeze_core.constants is not None
    assert elastic_deepfreeze.cli is not None
    assert elastic_deepfreeze_core.actions is not None
    assert elastic_deepfreeze.config is not None
    assert elastic_deepfreeze.validators is not None


def test_no_curator_imports_in_package():
    """Test that no curator imports are present in the package"""
    # Get the package directory
    import elastic_deepfreeze

    package_dir = Path(elastic_deepfreeze.__file__).parent

    # Check all Python files in the package
    curator_imports_found = []

    for py_file in package_dir.rglob("*.py"):
        with open(py_file) as f:
            try:
                tree = ast.parse(f.read())
            except SyntaxError:
                continue

            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name.startswith("curator"):
                            curator_imports_found.append(
                                f"{py_file.relative_to(package_dir)}: import {alias.name}"
                            )
                elif isinstance(node, ast.ImportFrom):
                    if node.module and node.module.startswith("curator"):
                        curator_imports_found.append(
                            f"{py_file.relative_to(package_dir)}: from {node.module} import ..."
                        )

    assert (
        len(curator_imports_found) == 0
    ), "Found curator imports in deepfreeze package:\n" + "\n".join(
        curator_imports_found
    )


def test_entry_point_registration():
    """Test that the CLI entry point is properly configured"""
    import click
    from elastic_deepfreeze.cli.main import cli

    assert cli is not None
    assert isinstance(cli, click.core.Group)

    # Check that all expected commands are registered
    expected_commands = [
        "setup",
        "status",
        "rotate",
        "thaw",
        "refreeze",
        "cleanup",
        "repair-metadata",
    ]

    for cmd in expected_commands:
        assert cmd in cli.commands, f"Command '{cmd}' not found in CLI"
