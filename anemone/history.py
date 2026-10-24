"""Per-kind usage history in SQLite, used to right-size the next task of the same kind."""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path


class History:
    def __init__(self, path: Path):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS runs (kind TEXT, cpu_peak REAL, mem_peak_gb REAL, mem_limit_gb REAL, duration REAL, oom INTEGER, ts REAL)"
        )
        self._db.commit()

    def record(self, kind: str, cpu_peak: float, mem_peak_gb: float, mem_limit_gb: float, duration: float, oom: bool) -> None:
        with self._lock:
            self._db.execute("INSERT INTO runs VALUES (?,?,?,?,?,?,?)", (kind, cpu_peak, mem_peak_gb, mem_limit_gb, duration, int(oom), time.time()))
            self._db.commit()

    def samples(self, kind: str, limit: int = 50) -> list[tuple[float, float]]:
        """Recent (cpu, mem) peaks. OOM-killed runs are skipped: their peak is the old limit, not the need."""
        with self._lock:
            rows = self._db.execute(
                "SELECT cpu_peak, mem_peak_gb FROM runs WHERE kind=? AND oom=0 ORDER BY ts DESC LIMIT ?", (kind, limit)
            ).fetchall()
        return [(r[0], r[1]) for r in rows]

    def last(self, kind: str) -> tuple[float, bool] | None:
        """(memory limit, was OOM-killed) of the most recent run of this kind."""
        with self._lock:
            row = self._db.execute("SELECT mem_limit_gb, oom FROM runs WHERE kind=? ORDER BY ts DESC LIMIT 1", (kind,)).fetchone()
        return (row[0], bool(row[1])) if row else None

    def close(self) -> None:
        with self._lock:
            self._db.close()
