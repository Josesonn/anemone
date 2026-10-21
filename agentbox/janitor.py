"""Removes agentbox containers whose owner process died or whose expiry passed (crash recovery)."""
from __future__ import annotations

import time

from .sandbox import LABEL, owner_alive


def sweep(client, everything: bool = False, keep_owner: str | None = None) -> int:
    removed = 0
    for c in client.containers.list(all=True, filters={"label": f"{LABEL}=true"}):
        owner = c.labels.get("agentbox.owner", "")
        try:
            expired = time.time() > float(c.labels.get("agentbox.expires", "0"))
        except ValueError:
            expired = True
        if everything or expired or (owner != keep_owner and not owner_alive(owner)):
            try:
                c.remove(force=True, v=True)
                removed += 1
            except Exception:
                pass
    return removed
