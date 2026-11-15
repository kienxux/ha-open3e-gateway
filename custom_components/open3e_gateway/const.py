"""Constants for the open3e gateway integration."""

DOMAIN = "open3e_gateway"
MANUFACTURER = "Viessmann"

CONF_SCAN_INTERVAL = "scan_interval"
CONF_LIVE_MIN_INTERVAL = "live_min_interval"

# With GET /api/values a refresh costs no CAN traffic, so poll often.
DEFAULT_SCAN_INTERVAL = 30
# Fallback mode (firmware without /api/values): each point is read live, never
# more often than its own interval on the gateway and never below this value.
DEFAULT_LIVE_MIN_INTERVAL = 120

PLATFORMS = ["sensor", "binary_sensor", "number", "switch"]

# Curated entities (Vitocal 150-A on HPMUMASTER).
ECU_MAIN = 0x680
DID_COMPRESSOR = 2351
DID_HEATER = 2352
DID_DHW_QUICK_TARGET = 1006
DID_DHW_QUICK_CURRENT = 1007
