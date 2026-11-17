"""Ships the heat pump card with the integration.

The card file is served from the integration directory and loaded on every
dashboard, so after installing the integration `type: custom:open3e-heatpump-card`
works without adding a dashboard resource by hand. The card asks the
websocket command `open3e_gateway/entities` which entity ids belong to which
datapoint field, so renamed entities keep working.
"""

from __future__ import annotations

from pathlib import Path

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.loader import async_get_integration

from .const import DOMAIN

CARD_FILE = Path(__file__).parent / "www" / "open3e-heatpump-card.js"
URL_BASE = f"/{DOMAIN}_static"
DATA_REGISTERED = f"{DOMAIN}_frontend"


async def async_register_frontend(hass: HomeAssistant) -> None:
    if hass.data.get(DATA_REGISTERED):
        return
    hass.data[DATA_REGISTERED] = True
    # Version from the loaded manifest (no file I/O in the event loop).
    version = (await async_get_integration(hass, DOMAIN)).version
    await hass.http.async_register_static_paths(
        [StaticPathConfig(f"{URL_BASE}/open3e-heatpump-card.js", str(CARD_FILE), True)]
    )
    # The version in the URL makes browsers fetch the new card after an update.
    add_extra_js_url(hass, f"{URL_BASE}/open3e-heatpump-card.js?v={version}")
    websocket_api.async_register_command(hass, ws_entities)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/entities"})
@callback
def ws_entities(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Entity ids per config entry, keyed like the unique ids (without the
    entry prefix): {"entries": [{"entry_id", "title", "entities": {key: entity_id}}]}."""
    reg = er.async_get(hass)
    entries = []
    for entry in hass.config_entries.async_entries(DOMAIN):
        prefix = f"{entry.entry_id}_"
        entities = {
            e.unique_id[len(prefix):]: e.entity_id
            for e in er.async_entries_for_config_entry(reg, entry.entry_id)
            if e.unique_id.startswith(prefix) and not e.disabled_by
        }
        entries.append({"entry_id": entry.entry_id, "title": entry.title, "entities": entities})
    connection.send_result(msg["id"], {"entries": entries})
