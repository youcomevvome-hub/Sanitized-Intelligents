"""Detector base classes."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List

import numpy as np

from sanitizer.core.types import Detection


class FaceDetector(ABC):
    @abstractmethod
    def detect(self, image: np.ndarray) -> List[Detection]:
        ...


class TextDetector(ABC):
    """Returns text regions with recognized strings as `label`."""
    @abstractmethod
    def detect(self, image: np.ndarray) -> List[Detection]:
        ...
