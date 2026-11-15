"""open3e gateway integration: local Viessmann E3 access via open3e-esp32."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv, device_registry as dr, entity_registry as er
from homeassistant.helpers.typing import ConfigType
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import GatewayError, Open3eGateway
from .const import (
    DOMAIN,
    CONF_LIVE_MIN_INTERVAL,
    CONF_SCAN_INTERVAL,
    DEFAULT_LIVE_MIN_INTERVAL,
    DEFAULT_SCAN_INTERVAL,
    PLATFORMS,
)
from .coordinator import Open3eCoordinator
from .entity import gateway_device_info
from .model import GatewayModel, devices_from_system, fields_for_datapoint

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the bundled heat pump card once per HA start."""
    from .frontend import async_register_frontend

    await async_register_frontend(hass)
    return True


@dataclass
class RuntimeData:
    api: Open3eGateway
    coordinator: Open3eCoordinator


type Open3eConfigEntry = ConfigEntry[RuntimeData]


async def build_model(api: Open3eGateway) -> GatewayModel:
    """Read selection and codec metadata once; entities are built from it."""
    system = await api.system()
    points = [p for p in await api.points() if p.get("enabled", True)]
    fields = []
    for point in points:
        try:
            meta = await api.datapoint(int(point["ecu"]), int(point["did"]), point.get("len"))
        except GatewayError as err:
            _LOGGER.warning(
                "no metadata for 0x%03x.%s, skipping: %s", point["ecu"], point["did"], err
            )
            continue
        fields.extend(fields_for_datapoint(point, meta))
    return GatewayModel(points=points, fields=fields, devices=devices_from_system(system))


async def async_setup_entry(hass: HomeAssistant, entry: Open3eConfigEntry) -> bool:
    api = Open3eGateway(async_get_clientsession(hass), entry.data[CONF_HOST])
    try:
        model = await build_model(api)
    except GatewayError as err:
        raise ConfigEntryNotReady(str(err)) from err

    coordinator = Open3eCoordinator(
        hass,
        api,
        model,
        scan_interval=entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
        live_min_interval=entry.options.get(CONF_LIVE_MIN_INTERVAL, DEFAULT_LIVE_MIN_INTERVAL),
    )
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = RuntimeData(api=api, coordinator=coordinator)

    # Register the gateway first so the ECU devices can link to it by id.
    gw = gateway_device_info(coordinator, entry.entry_id)
    coordinator.gateway_device_id = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers=gw.identifiers,
        name=gw.name,
        manufacturer=gw.manufacturer,
        model=gw.model,
        sw_version=gw.sw_version,
        configuration_url=gw.configuration_url,
    ).id

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _remove_stale_entities(hass, entry)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


def _remove_stale_entities(hass: HomeAssistant, entry: Open3eConfigEntry) -> None:
    """Datapoints removed from the gateway selection leave registry entries
    behind; drop the ones no platform created in this setup."""
    created = entry.runtime_data.coordinator.created_unique_ids
    if not created:
        return
    reg = er.async_get(hass)
    for ent in er.async_entries_for_config_entry(reg, entry.entry_id):
        if ent.unique_id not in created:
            reg.async_remove(ent.entity_id)


async def _async_reload(hass: HomeAssistant, entry: Open3eConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: Open3eConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
