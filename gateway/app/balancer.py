"""Spreads requests over an engine's replicas.

In Kubernetes an engine is several identical pods behind a headless Service,
whose DNS name resolves to one address per ready pod. A normal Service balances
per TCP connection, which is the wrong unit for LLM traffic: a request lasts
from a second to minutes, so equal connection counts are not equal load. This
picks the replica with the fewest requests in flight instead.

With Docker Compose the name resolves to one address and nothing changes.
"""

import asyncio
import socket
from collections import Counter

import httpx


async def replicas(base_url: str) -> list[str]:
    """One URL per address the engine's host name resolves to."""
    url = httpx.URL(base_url)
    found = await asyncio.get_running_loop().getaddrinfo(url.host, url.port, type=socket.SOCK_STREAM)
    # One address family only, so a dual-stack pod is not counted as two replicas.
    family = found[0][0]
    return sorted({str(url.copy_with(host=address[0])) for kind, *_, address in found if kind == family})


class Balancer:
    def __init__(self) -> None:
        # Counted per gateway process. Several gateway replicas each see only
        # their own share, which is still a fair proxy for load.
        self.in_flight: Counter[str] = Counter()

    async def acquire(self, base_url: str) -> str:
        """The least busy replica of an engine. Call `release` when its reply ends."""
        replica = min(await replicas(base_url), key=lambda url: self.in_flight[url])
        self.in_flight[replica] += 1
        return replica

    def release(self, replica: str) -> None:
        self.in_flight[replica] -= 1
