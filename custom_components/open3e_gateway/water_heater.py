"""Hot water as one water_heater entity.

Current temperature: DHW sensor (271). Target: DHW setpoint (396), writable
only if the gateway has a limit for it. Operation modes: heat_pump (normal)
and high_demand (one-time charge, DID 1006 with OpMode 2).
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.water_heater import (
    STATE_HEAT_PUMP,
    STATE_HIGH_DEMAND,
    WaterHeaterEntity,
    WaterHeaterEntityFeature,
)
from homeassistant.const import ATTR_TEMPERATURE, PRECISION_WHOLE, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import Open3eConfigEntry
from . import logic as L
from .coordinator import Open3eCoordinator
from .entity import Open3eCuratedEntity, add_tracked

KEY_SET = "0x680_396_value"


async def async_setup_entry(
    hass: HomeAssistant, entry: Open3eConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = entry.runtime_data.coordinator
    if coordinator.model.has(L.ECU, L.DID_DHW_TEMP) and coordinator.model.has(L.ECU, L.DID_DHW_SET):
        add_tracked(coordinator, async_add_entities, [DhwWaterHeater(coordinator, entry.entry_id)])


class DhwWaterHeater(Open3eCuratedEntity, WaterHeaterEntity):
    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_precision = PRECISION_WHOLE
    _attr_target_temperature_step = 1
    _attr_operation_list = [STATE_HEAT_PUMP, STATE_HIGH_DEMAND]

    def __init__(self, coordinator: Open3eCoordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "dhw", "open3e_warmwasser", "water_heater")
        self._set_field = self.field(KEY_SET)
        features = WaterHeaterEntityFeature(0)
        if self._set_field and self._set_field.writable:
            features |= WaterHeaterEntityFeature.TARGET_TEMPERATURE
            self._attr_min_temp = self._set_field.range_min
            self._attr_max_temp = self._set_field.range_max
        if coordinator.model.has(L.ECU, L.DID_QUICK_TARGET):
            features |= WaterHeaterEntityFeature.OPERATION_MODE
        self._attr_supported_features = features

    @property
    def available(self) -> bool:
        return super().available and self.current_temperature is not None

    @property
    def current_temperature(self) -> float | None:
        return L.num(L.get(self.data, L.DID_DHW_TEMP, "Actual"))

    @property
    def target_temperature(self) -> float | None:
        return L.num(L.get(self.data, L.DID_DHW_SET))

    @property
    def current_operation(self) -> str | None:
        on = L.is_on(L.get(self.data, L.DID_QUICK_TARGET, "Required"))
        if on is None:
            return STATE_HEAT_PUMP
        return STATE_HIGH_DEMAND if on else STATE_HEAT_PUMP

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        d = self.data
        state = L.get(d, L.DID_DHW_MODE, "State")
        return {
            "charging": L.is_on(L.get(d, L.DID_QUICK_CURRENT, "Required")),
            "compressor_for_dhw": bool(L.compressor_on(d) and L.valve_dhw(d)),
            "hysteresis_on": L.num(L.get(d, L.DID_DHW_HYST, "SetpointSwitchOn")),
            "hysteresis_off": L.num(L.get(d, L.DID_DHW_HYST, "SetpointSwitchOff")),
            "dhw_mode": state.get("Text") if isinstance(state, dict) else None,
        }

    async def async_set_temperature(self, **kwargs: Any) -> None:
        value = kwargs.get(ATTR_TEMPERATURE)
        if value is None:
            return
        fld = self._set_field
        if not fld or not fld.writable:
            raise HomeAssistantError("hot water setpoint has no write limit on the gateway")
        if not fld.range_min <= value <= fld.range_max:
            raise HomeAssistantError(
                f"{value} °C outside the gateway limit {fld.range_min:g}..{fld.range_max:g} °C"
            )
        await self.write(L.ECU, L.DID_DHW_SET, int(round(value)), force=fld.needs_force,
                         what="hot water setpoint")

    async def async_set_operation_mode(self, operation_mode: str) -> None:
        if operation_mode not in self._attr_operation_list:
            raise HomeAssistantError(f"unknown mode {operation_mode}")
        on = operation_mode == STATE_HIGH_DEMAND
        # OpMode 2 = one-time domestic hot water charge (open3e discussion #318).
        await self.write(L.ECU, L.DID_QUICK_TARGET, {"OpMode": 2, "Required": "on" if on else "off"},
                         force=False, what="one-time charge")
        if self.coordinator.model.has(L.ECU, L.DID_QUICK_CURRENT):
            await self.coordinator.async_read_back(L.ECU, L.DID_QUICK_CURRENT)
