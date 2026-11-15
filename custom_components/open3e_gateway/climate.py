"""Heating circuit 1 as a climate entity.

Target: room setpoint "Standard" (424), writable only within the gateway
limit. Mode and program come from 1415 and are read-only here: the heat pump's
own schedule decides, Home Assistant only shows it. hvac_action reflects
whether the compressor is heating the circuit right now (valve not on DHW).
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACAction,
    HVACMode,
)
from homeassistant.const import ATTR_TEMPERATURE, PRECISION_HALVES, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import Open3eConfigEntry
from . import logic as L
from .coordinator import Open3eCoordinator
from .entity import Open3eCuratedEntity, add_tracked

KEY_STANDARD = "0x680_424_Standard"


async def async_setup_entry(
    hass: HomeAssistant, entry: Open3eConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = entry.runtime_data.coordinator
    if coordinator.model.has(L.ECU, L.DID_ROOM_SET):
        add_tracked(coordinator, async_add_entities, [HeatingCircuitClimate(coordinator, entry.entry_id)])


def _mode(mode_id: int | None) -> HVACMode:
    if mode_id == 0:
        return HVACMode.OFF
    if mode_id == 255:
        return HVACMode.AUTO
    return HVACMode.HEAT


class HeatingCircuitClimate(Open3eCuratedEntity, ClimateEntity):
    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_precision = PRECISION_HALVES
    _attr_target_temperature_step = 0.5

    def __init__(self, coordinator: Open3eCoordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "heating_circuit", "open3e_heizkreis", "climate")
        self._fld = self.field(KEY_STANDARD)
        if self._fld and self._fld.writable:
            self._attr_supported_features = ClimateEntityFeature.TARGET_TEMPERATURE
            self._attr_min_temp = self._fld.range_min
            self._attr_max_temp = self._fld.range_max
        else:
            self._attr_supported_features = ClimateEntityFeature(0)

    @property
    def hvac_mode(self) -> HVACMode:
        return _mode(L.circuit_mode_id(self.data))

    @property
    def hvac_modes(self) -> list[HVACMode]:
        # Only the current mode: switching it is left to the heat pump.
        return [self.hvac_mode]

    @property
    def hvac_action(self) -> HVACAction | None:
        if self.hvac_mode == HVACMode.OFF:
            return HVACAction.OFF
        comp = L.compressor_on(self.data)
        if comp is None:
            return None
        if comp and not L.valve_dhw(self.data):
            return HVACAction.HEATING
        return HVACAction.IDLE

    @property
    def current_temperature(self) -> float | None:
        return None  # no room temperature sensor on the heat pump

    @property
    def target_temperature(self) -> float | None:
        return L.num(L.get(self.data, L.DID_ROOM_SET, "Standard"))

    @property
    def available(self) -> bool:
        return super().available and self.target_temperature is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        d = self.data
        program = L.get(d, L.DID_CIRCUIT_MODE, "State")
        return {
            "program": program.get("Text") if isinstance(program, dict) else None,
            "setpoint_comfort": L.num(L.get(d, L.DID_ROOM_SET, "Comfort")),
            "setpoint_reduced": L.num(L.get(d, L.DID_ROOM_SET, "Reduced")),
            "flow_temperature": L.num(L.get(d, L.DID_HK1_FLOW, "Actual")),
            "flow_target": L.num(L.get(d, L.DID_FLOW_TARGET)),
            "outside_temperature": L.num(L.get(d, L.DID_OUTSIDE, "Actual")),
            "curve_level": L.num(L.get(d, L.DID_CURVE, "Level")),
            "curve_gradient": L.num(L.get(d, L.DID_CURVE, "Gradient")),
        }

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        if hvac_mode != self.hvac_mode:
            raise HomeAssistantError("the operating mode is set on the heat pump, not here")

    async def async_set_temperature(self, **kwargs: Any) -> None:
        value = kwargs.get(ATTR_TEMPERATURE)
        if value is None:
            return
        fld = self._fld
        if not fld or not fld.writable:
            raise HomeAssistantError("room setpoint has no write limit on the gateway")
        if not fld.range_min <= value <= fld.range_max:
            raise HomeAssistantError(
                f"{value} °C outside the gateway limit {fld.range_min:g}..{fld.range_max:g} °C"
            )
        await self.write(L.ECU, L.DID_ROOM_SET, {"Standard": round(value * 2) / 2},
                         force=fld.needs_force, what="room setpoint")
