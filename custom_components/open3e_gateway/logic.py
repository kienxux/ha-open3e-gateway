"""Derived heat pump state from decoded datapoints (no Home Assistant imports).

`data` is the coordinator data: {(ecu, did): decoded value}. All functions
return None when a needed datapoint is missing, so entities show "unknown"
instead of a wrong state.

Enum IDs follow open3e's Open3Eenums.py:
  FourThreeWayValveModes 0 Heating/Cooling, 1 Internal Buffer, 2 Domestic Hot
      Water, 3 Heating/Cooling and Internal Buffer, 4 DHW and Internal Buffer
  PowerStates 0 Off, 1 On, 2 Out of range
  OpModes 0 Off, 1 Heating, 2 Parallel Heating/HotWater, 3 Parallel
      Heating/Cooling, 4 TestMode, 5 Cooling, 255 Automatic
"""

from __future__ import annotations

from typing import Any

ECU = 0x680
DID_FLOW = 268
DID_RETURN = 269
DID_DHW_TEMP = 271
DID_OUTSIDE = 274
DID_HK1_FLOW = 284
DID_DHW_SET = 396
DID_ROOM_SET = 424
DID_DHW_HYST = 1085
DID_DHW_MODE = 531
DID_CURVE = 880
DID_FLOW_TARGET = 987
DID_QUICK_TARGET = 1006
DID_QUICK_CURRENT = 1007
DID_CIRCUIT_MODE = 1415
DID_COMPRESSOR = 2351
DID_HEATER = 2352
DID_POWER_EL = 2488
DID_POWER_TH = 2496
DID_VALVE = 2735

VALVE_DHW = {2, 4}
OPERATING_STATES = ["off", "standby", "heating", "dhw", "heater"]


def get(data: dict, did: int, *path: str, ecu: int = ECU) -> Any:
    cur = (data or {}).get((ecu, did))
    for part in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def enum_id(value: Any) -> int | None:
    if isinstance(value, dict) and isinstance(value.get("ID"), (int, float)):
        return int(value["ID"])
    return None


def num(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def is_on(value: Any) -> bool | None:
    if isinstance(value, str):
        return value.lower() == "on"
    if isinstance(value, bool):
        return value
    return None


def compressor_on(data: dict) -> bool | None:
    sid = enum_id(get(data, DID_COMPRESSOR, "PowerState"))
    return None if sid is None else sid == 1


def heater_on(data: dict) -> bool | None:
    sid = enum_id(get(data, DID_HEATER, "PowerState"))
    return None if sid is None else sid == 1


def valve_dhw(data: dict) -> bool | None:
    vid = enum_id(get(data, DID_VALVE))
    return None if vid is None else vid in VALVE_DHW


def circuit_mode_id(data: dict) -> int | None:
    return enum_id(get(data, DID_CIRCUIT_MODE, "Mode"))


def operating_state(data: dict) -> str | None:
    """off / standby / heating / dhw / heater.

    Defrosting cannot be told apart with the selected datapoints; it shows as
    heating or dhw depending on the valve.
    """
    comp = compressor_on(data)
    if comp is None:
        return None
    if comp:
        dhw = valve_dhw(data)
        if dhw is None:
            return None
        return "dhw" if dhw else "heating"
    if heater_on(data):
        return "heater"
    if circuit_mode_id(data) == 0:
        return "off"
    return "standby"


def cop(data: dict) -> float | None:
    """Current COP = thermal / electrical power, only while the compressor runs
    and the electrical power is meaningful (> 50 W)."""
    if not compressor_on(data):
        return None
    el = num(get(data, DID_POWER_EL))
    th = num(get(data, DID_POWER_TH))
    if el is None or th is None or el <= 50:
        return None
    return round(th / el, 2)


def spread(data: dict) -> float | None:
    flow = num(get(data, DID_FLOW, "Actual"))
    ret = num(get(data, DID_RETURN, "Actual"))
    if flow is None or ret is None:
        return None
    return round(flow - ret, 1)
