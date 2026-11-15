"""Heating circuit 1 as a read-only climate entity, in flow temperatures.

Current: flow temperature of heating circuit 1 (284). The flow setpoint the
heat pump calculates from its heating curve (987) is an attribute; it is not
set here. To change it, set the heating curve level (number entity of 880):
one level step moves the flow setpoint by 1 K (measured on a Vitocal 150-A).
Mode and program (1415) are shown, not changed. hvac_action = heating while
the compressor heats the circuit (4/3-way valve not on hot water).
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACAction,
    HVACMode,
)
from homeassistant.const import PRECISION_TENTHS, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import Open3eConfigEntry
from . import logic as L
from .coordinator import Open3eCoordinator
from .entity import Open3eCuratedEntity, add_tracked


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
    # Read-only: the flow setpoint follows the heating curve; change the curve
    # level (number entity) instead.
    _attr_supported_features = ClimateEntityFeature(0)

    def __init__(self, coordinator: Open3eCoordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "heating_circuit", "open3e_heizkreis", "climate")

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
    def available(self) -> bool:
        return super().available and self.current_temperature is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        d = self.data
        program = L.get(d, L.DID_CIRCUIT_MODE, "State")
        return {
            "flow_target": L.num(L.get(d, L.DID_FLOW_TARGET)),
            "program": program.get("Text") if isinstance(program, dict) else None,
            "curve_level": L.num(L.get(d, L.DID_CURVE, "Level")),
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
