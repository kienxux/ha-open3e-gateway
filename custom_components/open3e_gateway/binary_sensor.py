"""Binary sensors: boolean fields plus curated running states."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import Open3eConfigEntry
from .const import DID_COMPRESSOR, DID_HEATER, ECU_MAIN
from .coordinator import Open3eCoordinator
from .entity import Open3eEntity, Open3eFieldEntity, add_tracked
from .model import bool_value, enum_id


async def async_setup_entry(
    hass: HomeAssistant, entry: Open3eConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = entry.runtime_data.coordinator
    entities: list[BinarySensorEntity] = [
        Open3eBoolSensor(coordinator, entry.entry_id, fld)
        for fld in coordinator.model.fields
        if fld.kind == "bool"
    ]
    # PowerState enums (compressor, electric heater) as running sensors.
    # Note: on the Vitocal 150-A the compressor state is only valid on 0x680.
    for did, key, name in (
        (DID_COMPRESSOR, "compressor_running", "Compressor running"),
        (DID_HEATER, "heater_running", "Electric heater running"),
    ):
        if coordinator.model.has(ECU_MAIN, did):
            entities.append(
                PowerStateSensor(coordinator, entry.entry_id, ECU_MAIN, did, key, name)
            )
    add_tracked(coordinator, async_add_entities, entities)


class Open3eBoolSensor(Open3eFieldEntity, BinarySensorEntity):
    @property
    def is_on(self) -> bool | None:
        return bool_value(self.raw_value)


class PowerStateSensor(Open3eEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.RUNNING

    def __init__(
        self,
        coordinator: Open3eCoordinator,
        entry_id: str,
        ecu: int,
        did: int,
        key: str,
        name: str,
    ) -> None:
        super().__init__(coordinator, entry_id, ecu)
        self._key = (ecu, did)
        self._attr_unique_id = f"{entry_id}_{key}"
        self._attr_translation_key = key
        self.entity_id = f"binary_sensor.open3e_{'electric_heater_running' if key == 'heater_running' else key}"

    @property
    def _state(self) -> Any:
        value = (self.coordinator.data or {}).get(self._key)
        return value.get("PowerState") if isinstance(value, dict) else None

    @property
    def available(self) -> bool:
        return super().available and enum_id(self._state) is not None

    @property
    def is_on(self) -> bool | None:
        sid = enum_id(self._state)
        return None if sid is None else sid != 0
