"""Config and options flow: set up with the gateway's IP address."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_HOST
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import GatewayError, Open3eGateway
from .const import (
    CONF_LIVE_MIN_INTERVAL,
    CONF_SCAN_INTERVAL,
    DEFAULT_LIVE_MIN_INTERVAL,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
)


class Open3eConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            api = Open3eGateway(async_get_clientsession(self.hass), host)
            try:
                status = await api.status()
                system = await api.system()
            except GatewayError:
                errors["base"] = "cannot_connect"
            else:
                if not status.get("dbLoaded"):
                    errors["base"] = "no_database"
                else:
                    await self.async_set_unique_id(_unique_id(system, host))
                    self._abort_if_unique_id_configured(updates={CONF_HOST: host})
                    return self.async_create_entry(
                        title=f"open3e ({host})", data={CONF_HOST: host}
                    )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_HOST): str}),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return Open3eOptionsFlow()


def _unique_id(system: dict[str, Any], host: str) -> str:
    """Prefer the heat pump's identity so a changed IP does not create a
    second entry; fall back to the host."""
    for dev in system.get("devices") or []:
        ident = dev.get("ident") or dev.get("vin")
        if ident:
            return str(ident)
    return host


class Open3eOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        opts = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_SCAN_INTERVAL,
                    default=opts.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
                ): vol.All(int, vol.Range(min=10, max=3600)),
                vol.Required(
                    CONF_LIVE_MIN_INTERVAL,
                    default=opts.get(CONF_LIVE_MIN_INTERVAL, DEFAULT_LIVE_MIN_INTERVAL),
                ): vol.All(int, vol.Range(min=30, max=3600)),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
