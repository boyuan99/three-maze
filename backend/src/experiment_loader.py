"""
experiment_loader.py

Dynamic experiment loader with lazy loading support.

This module allows users to add Python experiment files to the experiments/
folder without manually registering them in the backend code.

Features:
- Automatic discovery of experiment files
- Lazy loading (only load when needed)
- Standard class name convention (Experiment)
- No manual registration required

Usage:
    loader = ExperimentLoader()
    experiment_class = loader.load_experiment('my_experiment.py', 'managed')
"""

import os
import importlib.util
import sys
import logging
from pathlib import Path
from typing import Optional, Dict, Any, Type

logger = logging.getLogger(__name__)


class ExperimentLoader:
    """
    Dynamic experiment loader with lazy loading.

    Scans experiments/ folder and loads experiment classes on demand.
    """

    def __init__(self, experiments_dir: str = "experiments"):
        """
        Initialize experiment loader.

        Args:
            experiments_dir: Directory containing experiment Python files
        """
        self.experiments_dir = Path(experiments_dir)
        self.available_experiments = {}  # filename -> metadata
        self.loaded_classes = {}  # filename -> class (cache)

        # Scan available experiments on startup (fast - just file names)
        self._scan_experiments()

    def _scan_experiments(self):
        """
        Scan experiments directory for Python files.

        This is fast - only reads file names, doesn't import modules.
        """
        if not self.experiments_dir.exists():
            logger.warning(f"Experiments directory not found: {self.experiments_dir}")
            return

        for file_path in self.experiments_dir.glob("*.py"):
            if file_path.name.startswith("_"):
                continue  # Skip __init__.py and private files

            filename = file_path.name

            # Store metadata (don't load the module yet!)
            self.available_experiments[filename] = {
                "path": str(file_path),
                "loaded": False,
                "class": None
            }

        logger.info(f"Found {len(self.available_experiments)} experiments in {self.experiments_dir}")

    def get_available_experiments(self) -> list:
        """
        Get list of available experiment filenames.

        Returns:
            List of experiment filenames (e.g., ['my_experiment.py'])
        """
        return list(self.available_experiments.keys())

    def load_experiment(self, filename: str, hardware_mode: str = 'managed') -> Type:
        """
        Load experiment class from file (lazy loading).

        This is called only when user actually selects an experiment.

        Args:
            filename: Name of Python file (e.g., 'my_experiment.py')
            hardware_mode: Hardware mode ('managed' or 'autonomous')

        Returns:
            Experiment class (not instance!)

        Raises:
            FileNotFoundError: If experiment file doesn't exist
            ImportError: If module cannot be imported
            ValueError: If no valid Experiment class found
        """
        # Check if already loaded (use cache)
        if filename in self.loaded_classes:
            logger.debug(f"Using cached experiment class: {filename}")
            return self.loaded_classes[filename]

        # Check if file exists in available experiments
        if filename not in self.available_experiments:
            raise FileNotFoundError(f"Experiment file not found: {filename}")

        file_path = self.available_experiments[filename]["path"]

        logger.info(f"Loading experiment from file: {filename}")

        try:
            # Dynamically import the module
            spec = importlib.util.spec_from_file_location(
                f"experiments.{filename[:-3]}",  # Remove .py extension
                file_path
            )

            if spec is None or spec.loader is None:
                raise ImportError(f"Could not load spec for {filename}")

            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)

            # Find the Experiment class
            experiment_class = self._find_experiment_class(module, filename)

            # Validate hardware mode
            class_mode = getattr(experiment_class, 'HARDWARE_MODE', 'managed')
            if class_mode != hardware_mode:
                logger.warning(
                    f"Experiment {filename} has HARDWARE_MODE={class_mode}, "
                    f"but requested {hardware_mode}. Using class mode."
                )

            # Cache the loaded class
            self.loaded_classes[filename] = experiment_class
            self.available_experiments[filename]["loaded"] = True
            self.available_experiments[filename]["class"] = experiment_class

            logger.info(f"Successfully loaded experiment class: {experiment_class.__name__}")

            return experiment_class

        except Exception as e:
            logger.error(f"Error loading experiment {filename}: {e}", exc_info=True)
            raise

    def _is_valid_experiment_class(self, cls) -> bool:
        """
        Check if a class is a valid experiment class (duck typing).

        A valid experiment class must have these methods:
        - __init__(experiment_id, config, hardware_manager)
        - initialize(config) -> Dict
        - process_serial_data(data) -> Optional[Dict]
        - get_state() -> Dict
        - terminate() -> Dict

        Args:
            cls: Class to check

        Returns:
            True if class has required methods
        """
        required_methods = ['initialize', 'process_serial_data', 'get_state', 'terminate']

        for method_name in required_methods:
            if not hasattr(cls, method_name):
                return False
            method = getattr(cls, method_name)
            if not callable(method):
                return False

        return True

    def _find_experiment_class(self, module, filename: str) -> Type:
        """
        Find the Experiment class in a module.

        Supports two patterns:
        1. Classes inheriting from ExperimentBase (managed/autonomous mode)
        2. Standalone classes with required interface (standalone mode)

        Looks for classes in this order:
        1. Class named 'Experiment' (with or without ExperimentBase)
        2. Class ending with 'Experiment' (with or without ExperimentBase)
        3. Any class inheriting from ExperimentBase
        4. Any class with valid experiment interface

        Args:
            module: Imported Python module
            filename: Filename for error messages

        Returns:
            Experiment class

        Raises:
            ValueError: If no valid experiment class found
        """
        from backend.src.experiment_base import ExperimentBase

        experiment_classes = []  # Classes inheriting from ExperimentBase
        standalone_classes = []  # Classes with valid interface but no inheritance

        # Find all classes in module
        for name in dir(module):
            obj = getattr(module, name)

            # Check if it's a class
            if not isinstance(obj, type):
                continue

            # Skip imported classes from other modules (except if defined in this file)
            if hasattr(obj, '__module__') and obj.__module__ != module.__name__:
                continue

            # Check if it inherits from ExperimentBase
            try:
                if issubclass(obj, ExperimentBase) and obj is not ExperimentBase:
                    experiment_classes.append((name, obj))
                    logger.debug(f"Found ExperimentBase subclass: {name}")
                    continue
            except TypeError:
                pass

            # Check if it's a standalone class with valid interface
            if self._is_valid_experiment_class(obj):
                standalone_classes.append((name, obj))
                logger.debug(f"Found standalone experiment class: {name}")

        # Combine both lists for searching
        all_classes = experiment_classes + standalone_classes

        if not all_classes:
            raise ValueError(
                f"No Experiment class found in {filename}. "
                f"Class must either inherit from ExperimentBase or implement the required interface "
                f"(initialize, process_serial_data, get_state, terminate methods)."
            )

        # Priority 1: Class named exactly 'Experiment'
        for name, cls in all_classes:
            if name == 'Experiment':
                class_type = "ExperimentBase subclass" if (name, cls) in experiment_classes else "standalone"
                logger.info(f"Found standard class name 'Experiment' ({class_type})")
                return cls

        # Priority 2: Class ending with 'Experiment'
        for name, cls in all_classes:
            if name.endswith('Experiment'):
                class_type = "ExperimentBase subclass" if (name, cls) in experiment_classes else "standalone"
                logger.info(f"Found experiment class: {name} ({class_type})")
                return cls

        # Priority 3: First class found (prefer ExperimentBase subclasses)
        if experiment_classes:
            logger.debug(f"Using first ExperimentBase subclass: {experiment_classes[0][0]}")
            return experiment_classes[0][1]
        else:
            logger.debug(f"Using first standalone class: {standalone_classes[0][0]}")
            return standalone_classes[0][1]

    def unload_experiment(self, filename: str):
        """
        Unload experiment class from cache (free memory).

        Args:
            filename: Experiment filename
        """
        if filename in self.loaded_classes:
            del self.loaded_classes[filename]
            self.available_experiments[filename]["loaded"] = False
            self.available_experiments[filename]["class"] = None
            logger.info(f"Unloaded experiment: {filename}")

    def reload_experiment(self, filename: str, hardware_mode: str = 'managed') -> Type:
        """
        Reload experiment class (useful for development).

        Args:
            filename: Experiment filename
            hardware_mode: Hardware mode

        Returns:
            Reloaded experiment class
        """
        self.unload_experiment(filename)
        return self.load_experiment(filename, hardware_mode)

    def get_experiment_info(self, filename: str) -> Optional[Dict[str, Any]]:
        """
        Get information about an experiment without loading it.

        Args:
            filename: Experiment filename

        Returns:
            Experiment metadata dict or None
        """
        return self.available_experiments.get(filename)
