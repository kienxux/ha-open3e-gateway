"""Number controls for fields that have a write limit on the gateway."""

from __future__ import annotations

from homeassistant.components.number import NumberDeviceClass, NumberEntity, NumberMode
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import Open3eConfigEntry
from .api import GatewayWriteError
from .coordinator import Open3eCoordinator
from .entity import Open3eFieldEntity, add_tracked
from .model import Field


async def async_setup_entry(
    hass: HomeAssistant, entry: Open3eConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = entry.runtime_data.coordinator
    add_tracked(
        coordinator,
        async_add_entities,
        [
            Open3eNumber(coordinator, entry.entry_id, fld)
            for fld in coordinator.model.fields
            # Only top-level fields: the gateway merges omitted fields at the
            # top level only, so a nested field would need its whole sub-object.
            if fld.writable and len(fld.path) <= 1
        ],
    )


class Open3eNumber(Open3eFieldEntity, NumberEntity):
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator: Open3eCoordinator, entry_id: str, fld: Field) -> None:
        super().__init__(coordinator, entry_id, fld)
        self._attr_native_min_value = fld.range_min
        self._attr_native_max_value = fld.range_max
        self._attr_native_unit_of_measurement = fld.unit or None
        if fld.unit == "°C":
            self._attr_device_class = NumberDeviceClass.TEMPERATURE
        # Resolution of the datapoint: scale 10 -> 0.1. Temperatures in 0.5.
        if fld.scale and fld.scale > 1:
            step = 1 / fld.scale
            self._attr_native_step = 0.5 if fld.unit == "°C" else step
        else:
            self._attr_native_step = 1

    @property
    def native_value(self) -> float | None:
        value = self.raw_value
        return float(value) if isinstance(value, (int, float)) else None

    async def async_set_native_value(self, value: float) -> None:
        fld = self.field
        out: float | int = int(round(value)) if self._attr_native_step == 1 else round(value, 2)
        payload = {fld.path[0]: out} if fld.path else out
        try:
            await self.coordinator.api.write(fld.ecu, fld.did, payload, force=fld.needs_force)
        except GatewayWriteError as err:
            raise HomeAssistantError(f"{fld.name}: {err}") from err
        await self.coordinator.async_read_back(fld.ecu, fld.did)
