"""IV Rank and IV Percentile over a trailing window of historical IV."""
from __future__ import annotations

from collections.abc import Sequence


def iv_rank(current_iv: float, history: Sequence[float]) -> float:
    """IV Rank = (current - min) / (max - min) over the window, in [0, 100]."""
    if not history:
        return 0.0
    lo, hi = min(history), max(history)
    if hi == lo:
        return 0.0
    return max(0.0, min(100.0, (current_iv - lo) / (hi - lo) * 100.0))


def iv_percentile(current_iv: float, history: Sequence[float]) -> float:
    """Percent of days in the window with IV below the current value."""
    if not history:
        return 0.0
    below = sum(1 for v in history if v < current_iv)
    return below / len(history) * 100.0
