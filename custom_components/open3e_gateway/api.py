"""Async client for the open3e-esp32 gateway HTTP API.

No Home Assistant imports here, so the client can be exercised on its own.
The API has no authentication; it is meant for the local network only.
"""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp

DEFAULT_TIMEOUT = aiohttp.ClientTimeout(total=15)
# A live CAN read may wait for the bus; give it more room than a cached call.
READ_TIMEOUT = aiohttp.ClientTimeout(total=20)


class GatewayError(Exception):
    """The gateway answered with an error or could not be reached."""


class GatewayWriteError(GatewayError):
    """The gateway refused a write (limits, read-only, write disabled...)."""


class Open3eGateway:
    """Thin wrapper around the gateway endpoints this integration needs."""

    def __init__(self, session: aiohttp.ClientSession, host: str) -> None:
        host = host.strip().rstrip("/")
        if not host.startswith(("http://", "https://")):
            host = f"http://{host}"
        self._base = host
        self._session = session
        # The gateway serialises CAN access anyway; serialising here as well
        # keeps us from queueing many slow requests on its small HTTP server.
        self._lock = asyncio.Lock()

    @property
    def base_url(self) -> str:
        return self._base

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        timeout: aiohttp.ClientTimeout = DEFAULT_TIMEOUT,
        allow_404: bool = False,
    ) -> Any:
        url = f"{self._base}{path}"
        async with self._lock:
            try:
                async with self._session.request(
                    method, url, params=params, json=json, timeout=timeout
                ) as resp:
                    if allow_404 and resp.status == 404:
                        return None
                    try:
                        body = await resp.json(content_type=None)
                    except (aiohttp.ContentTypeError, ValueError) as err:
                        raise GatewayError(
                            f"{path}: invalid JSON (HTTP {resp.status})"
                        ) from err
                    if resp.status >= 400:
                        msg = body.get("error") if isinstance(body, dict) else None
                        raise GatewayError(f"{path}: {msg or f'HTTP {resp.status}'}")
                    return body
            except (aiohttp.ClientError, asyncio.TimeoutError) as err:
                raise GatewayError(f"{path}: {err or type(err).__name__}") from err

    # --- metadata -----------------------------------------------------------

    async def status(self) -> dict[str, Any]:
        return await self._request("GET", "/api/status")

    async def system(self) -> dict[str, Any]:
        return await self._request("GET", "/api/system")

    async def points(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "/api/points")
        # The selection file also holds energy-meter frames (CAN-ID instead of
        # ECU/DID); only datapoints are of interest here.
        return [
            p
            for p in data or []
            if isinstance(p, dict) and "ecu" in p and "did" in p
        ]

    async def datapoint(self, ecu: int, did: int, length: int | None = None) -> dict:
        params: dict[str, Any] = {"ecu": f"0x{ecu:03x}", "did": did}
        if length:
            params["len"] = length
        return await self._request("GET", "/api/datapoint", params=params)

    # --- values -------------------------------------------------------------

    async def values(self) -> dict[str, Any] | None:
        """Cached values from the poller, or None if the firmware lacks
        GET /api/values (then the caller falls back to live reads)."""
        return await self._request("GET", "/api/values", allow_404=True)

    async def read(self, ecu: int, did: int) -> Any:
        """Live read of one datapoint -- costs a CAN request."""
        data = await self._request(
            "GET",
            "/api/read",
            params={"ecu": f"0x{ecu:03x}", "did": did},
            timeout=READ_TIMEOUT,
        )
        return data.get("value") if isinstance(data, dict) else None

    async def write(self, ecu: int, did: int, value: Any, *, force: bool) -> None:
        """Write a (partial) value. The gateway fills omitted fields from the
        current value and enforces its configured limits."""
        try:
            await self._request(
                "POST",
                "/api/write",
                json={"ecu": ecu, "did": did, "value": value, "force": force},
                timeout=READ_TIMEOUT,
            )
        except GatewayError as err:
            raise GatewayWriteError(str(err)) from err
