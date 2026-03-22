"""Deepfreeze TUI - Terminal User Interface

A Textual-based operator dashboard for deepfreeze.
"""

__version__ = "1.0.0"

from .app import DeepfreezeApp
from .screens.overview import OverviewScreen
from .screens.repositories import RepositoriesScreen
from .screens.thaw import ThawScreen
from .screens.operations import OperationsScreen
from .screens.configuration import ConfigurationScreen
from .screens.logs import LogsScreen

__all__ = [
    "DeepfreezeApp",
    "OverviewScreen",
    "RepositoriesScreen",
    "ThawScreen",
    "OperationsScreen",
    "ConfigurationScreen",
    "LogsScreen",
]
