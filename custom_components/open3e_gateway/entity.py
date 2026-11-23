"""Base entity classes."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, MANUFACTURER
from .coordinator import Open3eCoordinator
from .model import Field


# Known ECUs of a Vitocal 150-A get readable, translated device names.
DEVICE_KEYS = {0x680: "heat_pump", 0x68C: "refrigerant_circuit", 0x6CF: "ehcu"}


def add_tracked(coordinator: Open3eCoordinator, async_add_entities, entities) -> None:
    """Add entities and remember their unique ids (including ones that are
    disabled and never reach hass), for removing stale registry entries."""
    entities = list(entities)
    coordinator.created_unique_ids.update(e.unique_id for e in entities if e.unique_id)
    coordinator.enabled_default_ids.update(
        e.unique_id for e in entities if e.unique_id and e.entity_registry_enabled_default
    )
    async_add_entities(entities)


def gateway_device_info(coordinator: Open3eCoordinator, entry_id: str) -> DeviceInfo:
    status = coordinator.status or {}
    return DeviceInfo(
        identifiers={(DOMAIN, f"{entry_id}_gateway")},
        name="open3e Gateway",
        manufacturer="open3e-esp32",
        model="ESP32 CAN gateway",
        sw_version=status.get("firmware"),
        configuration_url=coordinator.api.base_url,
    )


def ecu_device_info(coordinator: Open3eCoordinator, entry_id: str, ecu: int) -> DeviceInfo:
    dev = coordinator.model.devices.get(ecu)
    name = f"{dev.name} (0x{ecu:03x})" if dev else f"ECU 0x{ecu:03x}"
    key = DEVICE_KEYS.get(ecu)
    return DeviceInfo(
        identifiers={(DOMAIN, f"{entry_id}_0x{ecu:03x}")},
        # Translated name for known ECUs (e.g. "Wärmepumpe"); a name set by
        # the user in HA always wins.
        translation_key=key,
        name=None if key else name,
        manufacturer=MANUFACTURER,
        model=dev.model if dev else None,
        sw_version=dev.sw if dev else None,
        hw_version=dev.hw if dev else None,
        serial_number=dev.serial if dev else None,
        via_device_id=coordinator.gateway_device_id,
    )


class Open3eEntity(CoordinatorEntity[Open3eCoordinator]):
    _attr_has_entity_name = True

    def __init__(self, coordinator: Open3eCoordinator, entry_id: str, ecu: int) -> None:
        super().__init__(coordinator)
        self._entry_id = entry_id
        self._attr_device_info = ecu_device_info(coordinator, entry_id, ecu)


class Open3eCuratedEntity(Open3eEntity):
    """A hand-made entity with a fixed entity id and a translated name, so
    dashboards and automations can rely on it."""

    def __init__(self, coordinator: Open3eCoordinator, entry_id: str, key: str,
                 object_id: str, domain: str, ecu: int = 0x680) -> None:
        super().__init__(coordinator, entry_id, ecu)
        self._attr_unique_id = f"{entry_id}_{key}"
        self._attr_translation_key = key
        # Only a suggestion for the first registration; a user rename wins.
        self.entity_id = f"{domain}.{object_id}"

    @property
    def data(self) -> dict:
        return self.coordinator.data or {}

    def field(self, key: str):
        return self.coordinator.model.field_by_key(key)

    async def write(self, ecu: int, did: int, value, *, force: bool, what: str) -> None:
        from homeassistant.exceptions import HomeAssistantError

        from .api import GatewayWriteError

        try:
            await self.coordinator.api.write(ecu, did, value, force=force)
        except GatewayWriteError as err:
            raise HomeAssistantError(f"{what}: {err}") from err
        await self.coordinator.async_read_back(ecu, did)


class Open3eFieldEntity(Open3eEntity):
    """An entity backed by one field of one datapoint."""

    def __init__(self, coordinator: Open3eCoordinator, entry_id: str, fld: Field) -> None:
        super().__init__(coordinator, entry_id, fld.ecu)
        self.field = fld
        self._attr_unique_id = f"{entry_id}_{fld.key}"
        self._attr_name = fld.name
        if fld.secondary:
            self._attr_entity_registry_enabled_default = False

    @property
    def raw_value(self) -> Any:
        data = self.coordinator.data or {}
        value = data.get((self.field.ecu, self.field.did))
        return None if value is None else self.field.extract(value)

    @property
    def available(self) -> bool:
        return super().available and self.raw_value is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        age = self.coordinator.ages_ms.get((self.field.ecu, self.field.did))
        attrs: dict[str, Any] = {
            "ecu": f"0x{self.field.ecu:03x}",
            "did": self.field.did,
        }
        if age is not None:
            attrs["value_age_s"] = round(age / 1000)
        return attrs
