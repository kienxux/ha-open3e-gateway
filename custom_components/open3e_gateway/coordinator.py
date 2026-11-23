"""Data coordinator: one refresh fetches all selected datapoints.

Preferred source is GET /api/values (the gateway's poller cache, no CAN
traffic). Older firmware lacks it; then each datapoint is read live, but never
more often than its own polling interval on the gateway, to keep bus load low.
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import GatewayError, Open3eGateway
from .const import DOMAIN
from .model import GatewayModel, selection_signature

# How often the gateway's selection is checked for changes.
SELECTION_CHECK_S = 300

_LOGGER = logging.getLogger(__name__)

PointKey = tuple[int, int]


class Open3eCoordinator(DataUpdateCoordinator[dict[PointKey, Any]]):
    def __init__(
        self,
        hass: HomeAssistant,
        api: Open3eGateway,
        model: GatewayModel,
        scan_interval: int,
        live_min_interval: int,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=scan_interval),
        )
        self.api = api
        self.model = model
        self.live_min_interval = live_min_interval
        self.status: dict[str, Any] = {}
        self.cached_api: bool | None = None  # None = not probed yet
        self.ages_ms: dict[PointKey, int | None] = {}
        self._values: dict[PointKey, Any] = {}
        self._next_live: dict[PointKey, float] = {}
        # Read-back values newer than the gateway cache (monotonic time).
        self._fresh: dict[PointKey, float] = {}
        self._signature = selection_signature(model.points)
        self._next_selection_check = time.monotonic() + SELECTION_CHECK_S
        self.selection_changed = False
        # Filled by the entities as they are created; used to drop registry
        # entries of datapoints that left the selection.
        self.created_unique_ids: set[str] = set()
        # Unique ids of entities that are enabled by default in this version.
        self.enabled_default_ids: set[str] = set()
        # Device registry id of the gateway; the heat pump ECUs link to it.
        self.gateway_device_id: str | None = None

    async def _async_update_data(self) -> dict[PointKey, Any]:
        try:
            self.status = await self.api.status()
        except GatewayError as err:
            raise UpdateFailed(f"gateway not reachable: {err}") from err

        await self._check_selection()

        if self.cached_api is not False:
            try:
                payload = await self.api.values()
            except GatewayError as err:
                raise UpdateFailed(str(err)) from err
            if payload is None:
                _LOGGER.info(
                    "Gateway firmware has no /api/values; falling back to live "
                    "reads (min. %ss per datapoint)",
                    self.live_min_interval,
                )
                self.cached_api = False
            else:
                self.cached_api = True
                now = time.monotonic()
                for item in payload.get("values") or []:
                    key = (int(item["ecu"]), int(item["did"]))
                    age = item.get("ageMs")
                    if item.get("value") is None or age is None:
                        continue
                    # Keep a read-back value until the poller has read the
                    # datapoint again; otherwise a control would jump back.
                    fresh = self._fresh.get(key)
                    if fresh is not None and now - age / 1000 < fresh:
                        continue
                    self._fresh.pop(key, None)
                    self.ages_ms[key] = age
                    self._values[key] = item["value"]
                return dict(self._values)

        await self._live_reads()
        return dict(self._values)

    async def _check_selection(self) -> None:
        """Reload the entry when datapoints were added/removed or limits
        changed in the gateway's web UI, so entities follow the selection."""
        now = time.monotonic()
        if self.selection_changed or now < self._next_selection_check:
            return
        self._next_selection_check = now + SELECTION_CHECK_S
        try:
            points = await self.api.points()
        except GatewayError as err:
            _LOGGER.debug("selection check failed: %s", err)
            return
        if selection_signature(points) != self._signature:
            _LOGGER.info("Datapoint selection on the gateway changed; reloading")
            self.selection_changed = True
            entry = self.config_entry
            if entry is not None:
                self.hass.config_entries.async_schedule_reload(entry.entry_id)

    async def _live_reads(self) -> None:
        now = time.monotonic()
        failures = 0
        for point in self.model.points:
            if not point.get("enabled", True):
                continue
            key = (int(point["ecu"]), int(point["did"]))
            if self._next_live.get(key, 0) > now:
                continue
            interval = max(int(point.get("interval") or 60), self.live_min_interval)
            self._next_live[key] = now + interval
            try:
                self._values[key] = await self.api.read(*key)
                self.ages_ms[key] = 0
            except GatewayError as err:
                failures += 1
                _LOGGER.debug("live read 0x%03x.%s failed: %s", key[0], key[1], err)
        if failures and not self._values:
            raise UpdateFailed("no datapoint could be read")

    async def async_read_back(self, ecu: int, did: int) -> None:
        """After a write: the gateway does not republish, so read it live."""
        try:
            value = await self.api.read(ecu, did)
        except GatewayError as err:
            _LOGGER.warning("read-back of 0x%03x.%s failed: %s", ecu, did, err)
            return
        self._values[(ecu, did)] = value
        self.ages_ms[(ecu, did)] = 0
        self._fresh[(ecu, did)] = time.monotonic()
        self.async_set_updated_data(dict(self._values))
