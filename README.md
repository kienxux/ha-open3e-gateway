# open3e Gateway (ESP32) for Home Assistant

A custom integration for Viessmann E3 heat pumps (tested with a Vitocal 150-A)
through an [open3e-esp32](https://github.com/boonkerz/open3e-esp32) gateway. It
uses the gateway's local HTTP API. MQTT is not needed.

## Features

- Setup in the UI with the gateway's IP address.
- One entity for each field of every datapoint selected on the gateway: sensors
  (with units and device classes), enum text sensors and binary sensors. Min,
  max, average and status fields are created disabled.
- **Controls only where the gateway has a write limit.** A field becomes a
  `number` only if its datapoint has a `range` in the gateway's selection. The
  gateway enforces that limit on every write. Datapoints that the open3e DB
  marks read-only (e.g. 880 heating curve) are written with `force`. The limit
  still applies.
- Hot water one-time charge as a switch. Its state is the request (DID 1006).
  The heat pump's own state (1007) is in the `active` attribute and has its
  own binary sensor.
- Running sensors for the compressor (2351) and electric heater (2352).
- **Heating circuit flow** as a `climate`: current = circuit flow (284),
  target = flow setpoint (987). A new target shifts the heating curve level
  (880) by the difference, 1 K per level step (measured on a Vitocal 150-A),
  within the gateway's limit for the level.
- **Hot water** as a `water_heater` (temperature, setpoint 396, operation mode
  heat_pump / high_demand = one-time charge).
- Derived sensors: operating state (off / standby / heating / hot water /
  electric heater), current COP (thermal / electrical power while the
  compressor runs) and flow/return spread.
- German and English names; ECU devices are named "Wärmepumpe", "Kältekreis".
- Read-back after every write (the gateway does not republish).
- Gateway diagnostics: WLAN signal, CAN state and errors, poll failures.

## Heat pump card

The integration brings its own dashboard card; no extra resource is needed.
Add it via *Add card* (search for "open3e") or in YAML:

```yaml
type: custom:open3e-heatpump-card
normal_level_entity: input_number.wp_niveau_normal   # optional
```

![open3e heat pump card](docs/card.png)

Header: operating state, outside temperature, heat and electrical power, COP,
active errors. Tiles (tap for details / to change a setpoint):

| Tile | Colour |
|---|---|
| Heating circuit (mode) | orange = heating, grey = off |
| Compressor (+ speed) | green = running |
| Flow target / circuit flow | circuit flow green within ±2 K of the target, blue below, orange above |
| Heat pump flow | orange = heating, blue = hot water, grey = idle |
| Curve level | amber when it differs from `normal_level_entity` |
| Hot water / DHW target | blue = charging, red = below the switch-on point, green = ok |
| One-time charge, electric heater | blue / red when on |

Options: `title`, `tiles` (list and order of tiles: circuit, compressor,
flow_target, flow_hk, flow_wp, return, level, dhw, dhw_set, one_time, heater),
`entities` (override any entity, e.g. `flow_hk: sensor.x`), `entry_id`.

## Bus load

Gateway firmware with `GET /api/values` returns the poller's cached values, so
a refresh causes no CAN traffic (default every 30 s). With older firmware the
integration reads each datapoint live, but not more often than its gateway
interval and not more often than the "minimum interval" option (default 120 s).
The `can_state` diagnostic sensor shows which mode is active.

## Installation (HACS)

HACS → Custom repositories → add this repository as type *Integration* →
install → restart HA → Settings → Devices & services → Add → "open3e Gateway".

Requires Home Assistant 2026.11 or newer.

## Choosing datapoints

The gateway's selection decides which entities exist. Add or remove
datapoints, or set write limits, in the gateway's web UI (Datenpunkte). The
integration checks the selection every 5 minutes and reloads itself when it
changes. Entities of removed datapoints are deleted. To apply a change at once,
reload the integration. Changing only the polling interval or the topic does
not trigger a reload.

## Security

The gateway's HTTP API has no authentication. Use it on a trusted LAN only.

## License

MIT, see [LICENSE](LICENSE).
