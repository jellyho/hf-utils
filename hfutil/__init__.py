"""hfutil — reusable helpers for working with LeRobot datasets and the HF Hub.

This package is deliberately free of any web-framework and of ``lerobot``/``torch``
imports at module import time, so it can be embedded in other projects (and in the
hf-util web server) without dragging in a multi-second, multi-GB dependency chain.
Heavy work lives behind lazy imports inside the functions that need it.
"""

__version__ = "0.3.0"
