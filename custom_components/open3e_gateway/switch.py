"""Switch: domestic hot water one-time charge (DID 1006, feedback 1007)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import Open3eConfigEntry
from .api import GatewayWriteError
from .const import DID_DHW_QUICK_CURRENT, DID_DHW_QUICK_TARGET, ECU_MAIN
from .coordinator import Open3eCoordinator
from .entity import Open3eEntity, add_tracked
from .model import bool_value


async def async_setup_entry(
    hass: HomeAssistant, entry: Open3eConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = entry.runtime_data.coordinator
    if coordinator.model.has(ECU_MAIN, DID_DHW_QUICK_TARGET):
        add_tracked(coordinator, async_add_entities, [DhwOneTimeChargeSwitch(coordinator, entry.entry_id)])


class DhwOneTimeChargeSwitch(Open3eEntity, SwitchEntity):
    _attr_translation_key = "dhw_one_time_charge"
    _attr_icon = "mdi:water-boiler"

    def __init__(self, coordinator: Open3eCoordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, ECU_MAIN)
        self._attr_unique_id = f"{entry_id}_dhw_one_time_charge"
        self.entity_id = "switch.open3e_dhw_one_time_charge"

    def _required(self, did: int) -> bool | None:
        value = (self.coordinator.data or {}).get((ECU_MAIN, did))
        return bool_value(value.get("Required")) if isinstance(value, dict) else None

    @property
    def is_on(self) -> bool | None:
        # The request (1006) is read back right after a write. The heat
        # pump's own state (1007) follows only after a delay, so as the
        # switch state it would show the previous command for a while.
        return self._required(DID_DHW_QUICK_TARGET)

    @property
    def available(self) -> bool:
        return super().available and self.is_on is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if not self.coordinator.model.has(ECU_MAIN, DID_DHW_QUICK_CURRENT):
            return None
        return {"active": self._required(DID_DHW_QUICK_CURRENT)}

    async def _set(self, on: bool) -> None:
        # OpMode 2 = one-time domestic hot water charge (open3e discussion #318).
        try:
            await self.coordinator.api.write(
                ECU_MAIN,
                DID_DHW_QUICK_TARGET,
                {"OpMode": 2, "Required": "on" if on else "off"},
                force=False,
            )
        except GatewayWriteError as err:
            raise HomeAssistantError(f"one-time charge: {err}") from err
        await self.coordinator.async_read_back(ECU_MAIN, DID_DHW_QUICK_TARGET)

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._set(False)
