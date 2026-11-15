"""Sensors: every numeric/enum field of the selected datapoints, plus gateway
diagnostics."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.const import (
    PERCENTAGE,
    SIGNAL_STRENGTH_DECIBELS_MILLIWATT,
    EntityCategory,
    UnitOfTime,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import Open3eConfigEntry
from .coordinator import Open3eCoordinator
from .entity import Open3eFieldEntity, gateway_device_info, add_tracked
from .model import Field, enum_id, enum_text

UNIT_DEVICE_CLASS: dict[str, SensorDeviceClass] = {
    "°C": SensorDeviceClass.TEMPERATURE,
    "K": SensorDeviceClass.TEMPERATURE,
    "W": SensorDeviceClass.POWER,
    "kW": SensorDeviceClass.POWER,
    "kWh": SensorDeviceClass.ENERGY,
    "Wh": SensorDeviceClass.ENERGY,
    "hPa": SensorDeviceClass.PRESSURE,
    "bar": SensorDeviceClass.PRESSURE,
    "L/h": SensorDeviceClass.VOLUME_FLOW_RATE,
    "h": SensorDeviceClass.DURATION,
    "min": SensorDeviceClass.DURATION,
}
# Energy counters that only grow within their period (reset at its start).
INCREASING_PERIODS = {"Today", "CurrentMonth", "CurrentYear"}


async def async_setup_entry(
    hass: HomeAssistant, entry: Open3eConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = entry.runtime_data.coordinator
    entities: list[SensorEntity] = []
    for fld in coordinator.model.fields:
        if fld.writable or fld.kind == "bool":
            continue  # number / binary_sensor platforms
        if fld.kind == "enum":
            entities.append(Open3eEnumSensor(coordinator, entry.entry_id, fld))
        else:
            entities.append(Open3eNumberSensor(coordinator, entry.entry_id, fld))
    entities.extend(
        GatewaySensor(coordinator, entry.entry_id, desc) for desc in GATEWAY_SENSORS
    )
    add_tracked(coordinator, async_add_entities, entities)


class Open3eNumberSensor(Open3eFieldEntity, SensorEntity):
    def __init__(self, coordinator: Open3eCoordinator, entry_id: str, fld: Field) -> None:
        super().__init__(coordinator, entry_id, fld)
        unit = fld.unit or None
        if fld.is_list_count:
            self._attr_state_class = SensorStateClass.MEASUREMENT
            return
        self._attr_native_unit_of_measurement = unit
        dc = UNIT_DEVICE_CLASS.get(fld.unit)
        self._attr_device_class = dc
        if fld.decimals is not None:
            self._attr_suggested_display_precision = fld.decimals
        leaf = fld.path[-1] if fld.path else ""
        if dc == SensorDeviceClass.ENERGY:
            # Rolling windows (Past7Days, PastMonth, ...) fit no state class.
            if leaf in INCREASING_PERIODS:
                self._attr_state_class = SensorStateClass.TOTAL_INCREASING
        elif leaf in {"starts", "hours"}:
            self._attr_state_class = SensorStateClass.TOTAL_INCREASING
        elif dc == SensorDeviceClass.DURATION:
            pass  # a configured duration, not a measurement
        elif unit or dc:
            self._attr_state_class = SensorStateClass.MEASUREMENT

    @property
    def native_value(self) -> Any:
        value = self.raw_value
        return value if isinstance(value, (int, float)) else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        attrs = super().extra_state_attributes
        if self.field.is_list_count:
            data = (self.coordinator.data or {}).get((self.field.ecu, self.field.did))
            entries = self.field.list_entries(data)
            if entries is not None:
                attrs["entries"] = entries
        return attrs


class Open3eEnumSensor(Open3eFieldEntity, SensorEntity):
    @property
    def native_value(self) -> str | None:
        return enum_text(self.raw_value)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        attrs = super().extra_state_attributes
        attrs["id"] = enum_id(self.raw_value)
        if self.field.enum_list:
            attrs["enum_list"] = self.field.enum_list
        return attrs


@dataclass(frozen=True, kw_only=True)
class GatewaySensorDesc:
    key: str
    name: str
    value: Callable[[dict[str, Any]], Any]
    unit: str | None = None
    device_class: SensorDeviceClass | None = None
    state_class: SensorStateClass | None = SensorStateClass.MEASUREMENT
    enabled: bool = True


GATEWAY_SENSORS: tuple[GatewaySensorDesc, ...] = (
    GatewaySensorDesc(
        key="rssi",
        name="WLAN signal",
        value=lambda s: (s.get("net") or {}).get("rssi"),
        unit=SIGNAL_STRENGTH_DECIBELS_MILLIWATT,
        device_class=SensorDeviceClass.SIGNAL_STRENGTH,
    ),
    GatewaySensorDesc(
        key="uptime",
        name="Uptime",
        value=lambda s: s.get("uptimeS"),
        unit=UnitOfTime.SECONDS,
        device_class=SensorDeviceClass.DURATION,
        state_class=None,
        enabled=False,
    ),
    GatewaySensorDesc(
        key="can_bus_errors",
        name="CAN bus errors",
        value=lambda s: (s.get("can") or {}).get("busErrors"),
        state_class=SensorStateClass.TOTAL_INCREASING,
    ),
    GatewaySensorDesc(
        key="poll_failures",
        name="Poll failures",
        value=lambda s: (s.get("poll") or {}).get("failures"),
        state_class=SensorStateClass.TOTAL_INCREASING,
    ),
    GatewaySensorDesc(
        key="heap_free",
        name="Free heap",
        value=lambda s: round(s["heapFree"] / 1024) if s.get("heapFree") else None,
        unit="KiB",
        enabled=False,
    ),
    GatewaySensorDesc(
        key="can_state",
        name="CAN state",
        value=lambda s: (s.get("can") or {}).get("state"),
        state_class=None,
    ),
)


class GatewaySensor(CoordinatorEntity[Open3eCoordinator], SensorEntity):
    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: Open3eCoordinator, entry_id: str, desc: GatewaySensorDesc) -> None:
        super().__init__(coordinator)
        self._desc = desc
        self._attr_unique_id = f"{entry_id}_gateway_{desc.key}"
        self._attr_name = desc.name
        self._attr_native_unit_of_measurement = desc.unit
        self._attr_device_class = desc.device_class
        self._attr_state_class = desc.state_class
        self._attr_entity_registry_enabled_default = desc.enabled
        self._attr_device_info = gateway_device_info(coordinator, entry_id)

    @property
    def native_value(self) -> Any:
        return self._desc.value(self.coordinator.status or {})

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if self._desc.key != "can_state":
            return None
        mode = {True: "cached (/api/values)", False: "live reads", None: "unknown"}
        return {"value_source": mode[self.coordinator.cached_api]}
