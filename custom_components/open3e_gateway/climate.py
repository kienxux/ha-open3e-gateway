"""Heating circuit 1 as a climate entity, in flow temperatures.

Current: flow temperature of heating circuit 1 (284). Target: the flow
setpoint the heat pump calculates from its heating curve (987). The setpoint
cannot be written directly; a new target shifts the heating curve level (880)
by the difference, 1 K flow per level step (measured on a Vitocal 150-A), and
only within the gateway's limit for the level. Mode and program (1415) are
shown, not changed. hvac_action = heating while the compressor heats the
circuit (4/3-way valve not on hot water).
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACAction,
    HVACMode,
)
import asyncio

from homeassistant.const import ATTR_TEMPERATURE, PRECISION_TENTHS, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import Open3eConfigEntry
from . import logic as L
from .coordinator import Open3eCoordinator
from .entity import Open3eCuratedEntity, add_tracked

KEY_LEVEL = "0x680_880_Level"
# The heat pump recalculates the flow setpoint within a few seconds.
FLOW_TARGET_DELAY_S = 6


async def async_setup_entry(
    hass: HomeAssistant, entry: Open3eConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = entry.runtime_data.coordinator
    if coordinator.model.has(L.ECU, L.DID_HK1_FLOW) and coordinator.model.has(L.ECU, L.DID_FLOW_TARGET):
        add_tracked(coordinator, async_add_entities, [HeatingCircuitClimate(coordinator, entry.entry_id)])


def _mode(mode_id: int | None) -> HVACMode:
    if mode_id == 0:
        return HVACMode.OFF
    if mode_id == 255:
        return HVACMode.AUTO
    return HVACMode.HEAT


class HeatingCircuitClimate(Open3eCuratedEntity, ClimateEntity):
    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_precision = PRECISION_TENTHS
    _attr_target_temperature_step = 1

    def __init__(self, coordinator: Open3eCoordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "heating_circuit", "open3e_heizkreis", "climate")
        self._lvl = self.field(KEY_LEVEL)
        if self._lvl and self._lvl.writable:
            self._attr_supported_features = ClimateEntityFeature.TARGET_TEMPERATURE
        else:
            self._attr_supported_features = ClimateEntityFeature(0)

    @property
    def _level(self) -> float | None:
        return L.num(L.get(self.data, L.DID_CURVE, "Level"))

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
        return L.num(L.get(self.data, L.DID_HK1_FLOW, "Actual"))

    @property
    def target_temperature(self) -> float | None:
        return L.num(L.get(self.data, L.DID_FLOW_TARGET))

    def _bounds(self) -> tuple[float, float] | None:
        """Reachable flow setpoints = current setpoint shifted to the level limits."""
        target, level = self.target_temperature, self._level
        if target is None or level is None or not (self._lvl and self._lvl.writable):
            return None
        return target + self._lvl.range_min - level, target + self._lvl.range_max - level

    @property
    def min_temp(self) -> float:
        b = self._bounds()
        return round(b[0]) if b else 15

    @property
    def max_temp(self) -> float:
        b = self._bounds()
        return round(b[1]) if b else 70

    @property
    def available(self) -> bool:
        return super().available and self.target_temperature is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        d = self.data
        program = L.get(d, L.DID_CIRCUIT_MODE, "State")
        return {
            "program": program.get("Text") if isinstance(program, dict) else None,
            "curve_level": self._level,
            "curve_gradient": L.num(L.get(d, L.DID_CURVE, "Gradient")),
            "outside_temperature": L.num(L.get(d, L.DID_OUTSIDE, "Actual")),
            "primary_flow": L.num(L.get(d, L.DID_FLOW, "Actual")),
            "return_temperature": L.num(L.get(d, L.DID_RETURN, "Actual")),
            "room_setpoint_standard": L.num(L.get(d, L.DID_ROOM_SET, "Standard")),
            "room_setpoint_reduced": L.num(L.get(d, L.DID_ROOM_SET, "Reduced")),
            "room_setpoint_comfort": L.num(L.get(d, L.DID_ROOM_SET, "Comfort")),
        }

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        if hvac_mode != self.hvac_mode:
            raise HomeAssistantError("the operating mode is set on the heat pump, not here")

    async def async_set_temperature(self, **kwargs: Any) -> None:
        value = kwargs.get(ATTR_TEMPERATURE)
        if value is None:
            return
        fld, target, level = self._lvl, self.target_temperature, self._level
        if not fld or not fld.writable:
            raise HomeAssistantError("the heating curve level has no write limit on the gateway")
        if target is None or level is None:
            raise HomeAssistantError("flow setpoint or heating curve level not known yet")
        new_level = int(round(level + (value - target)))
        if not fld.range_min <= new_level <= fld.range_max:
            raise HomeAssistantError(
                f"{value} °C would need heating curve level {new_level}, outside the gateway "
                f"limit {fld.range_min:g}..{fld.range_max:g}"
            )
        if new_level == int(level):
            return
        await self.write(L.ECU, L.DID_CURVE, {"Level": new_level}, force=fld.needs_force,
                         what="heating curve level")
        self.hass.async_create_task(self._read_flow_target_later())

    async def _read_flow_target_later(self) -> None:
        await asyncio.sleep(FLOW_TARGET_DELAY_S)
        await self.coordinator.async_read_back(L.ECU, L.DID_FLOW_TARGET)
