"""Turn gateway datapoint metadata into entity descriptions.

Pure Python (no Home Assistant imports) so it can be tested against a live
gateway or recorded JSON.

A datapoint's codec is a tree (O3EComplexType with subTypes). Every leaf that
carries a usable value becomes one "field": a path into the decoded JSON plus
what we know about it (codec kind, unit, enum list, writable range).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

NUMERIC_CODECS = {
    "O3EInt8",
    "O3EInt16",
    "O3EInt32",
    "O3EByteVal",
    "O3EFloat32",
}
ENUM_CODECS = {"O3EEnum"}
BOOL_CODECS = {"O3EBool"}
# Raw bytes, timestamps, schedules and the like are not useful as entities.
SKIP_CODECS = {"RawCodec", "O3EDateTime", "O3ESdate", "O3EStime", "O3EUtc", "O3ECompStat"}

# Statistics fields that are rarely wanted; created disabled.
SECONDARY_FIELDS = {"Minimum", "Maximum", "Average", "SensorStatus", "ErrorState"}

UNIT_FIXES = {"l/h": "L/h"}


@dataclass(frozen=True)
class Field:
    ecu: int
    did: int
    did_name: str
    path: tuple[str, ...]  # () for a scalar datapoint
    codec: str
    unit: str = ""
    enum_list: str = ""
    decimals: int | None = None
    scale: float | None = None
    datapoint_acc: str = ""  # "rw"/"ro" of the whole datapoint
    range_min: float | None = None
    range_max: float | None = None
    is_list_count: bool = False

    @property
    def key(self) -> str:
        """Stable id part, e.g. 0x680_424_Standard."""
        suffix = "_".join(self.path) if self.path else "value"
        return f"0x{self.ecu:03x}_{self.did}_{suffix}"

    @property
    def kind(self) -> str:
        if self.codec in ENUM_CODECS:
            return "enum"
        if self.codec in BOOL_CODECS:
            return "bool"
        return "number"

    @property
    def writable(self) -> bool:
        """A field gets a control only if the operator configured a limit for
        it on the gateway. The gateway enforces that limit on every write, so
        the control can never go beyond what was deliberately allowed."""
        return (
            self.kind == "number"
            and not self.is_list_count
            and self.range_min is not None
            and self.range_max is not None
        )

    @property
    def needs_force(self) -> bool:
        # The open3e DB marks some writable datapoints read-only (e.g. 880).
        # Writing those over HTTP requires force; limits still apply.
        return self.datapoint_acc != "rw"

    @property
    def secondary(self) -> bool:
        return bool(self.path) and self.path[-1] in SECONDARY_FIELDS

    @property
    def name(self) -> str:
        base = humanize(self.did_name)
        if not self.path:
            return base
        return f"{base} {' '.join(humanize(p) for p in self.path)}"

    def extract(self, value: Any) -> Any:
        """Pick this field out of a decoded datapoint value."""
        cur = value
        for part in self.path:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(part)
        if self.is_list_count:
            if isinstance(cur, dict):
                return cur.get("Count")
            return None
        return cur


    def list_entries(self, value: Any) -> list | None:
        cur = value
        for part in self.path:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(part)
        if isinstance(cur, dict) and isinstance(cur.get("ListEntries"), list):
            return cur["ListEntries"]
        return None


def humanize(name: str) -> str:
    """'MixerOneCircuitFlowTemperature' -> 'Mixer One Circuit Flow Temperature'."""
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    s = re.sub(r"(?<=[a-z])(?=[0-9])", " ", s)
    s = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", s)
    return s[:1].upper() + s[1:]


def _range_for(rng: dict | None, path: tuple[str, ...]) -> tuple[float | None, float | None]:
    if not isinstance(rng, dict):
        return None, None
    leaf = path[-1] if path else None
    spec = rng.get(leaf) if leaf is not None else None
    if spec is None:
        spec = rng.get("*")
    if not isinstance(spec, dict):
        return None, None
    lo, hi = spec.get("min"), spec.get("max")
    if isinstance(lo, (int, float)) and isinstance(hi, (int, float)):
        return float(lo), float(hi)
    return None, None


def fields_for_datapoint(
    point: dict[str, Any], meta: dict[str, Any]
) -> list[Field]:
    """Flatten one datapoint's codec tree into fields.

    `point` is the entry from /api/points, `meta` the answer of /api/datapoint.
    """
    ecu, did = int(point["ecu"]), int(point["did"])
    did_name = meta.get("id") or f"DID{did}"
    top_args = meta.get("args") or {}
    acc = (top_args.get("acc") or meta.get("acc") or "").lower()
    rng = point.get("range")
    out: list[Field] = []

    def walk(node: dict[str, Any], path: tuple[str, ...]) -> None:
        codec = node.get("codec", "")
        args = node.get("args") or {}
        subs = args.get("subTypes")
        if codec == "O3EList":
            # Lists (e.g. active error messages) are exposed by their count;
            # the entries go into attributes.
            out.append(
                Field(ecu, did, did_name, path, codec, datapoint_acc=acc, is_list_count=True)
            )
            return
        if subs:
            for sub in subs:
                sid = sub.get("id")
                if sid:
                    walk(sub, path + (sid,))
            return
        if codec in SKIP_CODECS or codec not in NUMERIC_CODECS | ENUM_CODECS | BOOL_CODECS:
            return
        if path and path[-1].startswith("Unknown"):
            return
        unit = args.get("unit") or ""
        lo, hi = _range_for(rng, path)
        scale = args.get("scale")
        out.append(
            Field(
                ecu,
                did,
                did_name,
                path,
                codec,
                unit=UNIT_FIXES.get(unit, unit),
                enum_list=args.get("listStr") or "",
                decimals=_decimals(scale),
                scale=float(scale) if isinstance(scale, (int, float)) else None,
                datapoint_acc=acc,
                range_min=lo,
                range_max=hi,
            )
        )

    walk(meta, ())
    return out


def _decimals(scale: Any) -> int | None:
    if not isinstance(scale, (int, float)) or scale <= 1:
        return 0 if isinstance(scale, (int, float)) else None
    d = 0
    s = float(scale)
    while s >= 10 and d < 4:
        s /= 10
        d += 1
    return d


def enum_text(value: Any) -> str | None:
    if isinstance(value, dict):
        text = value.get("Text")
        return str(text) if text is not None else None
    return None if value is None else str(value)


def enum_id(value: Any) -> int | None:
    if isinstance(value, dict) and isinstance(value.get("ID"), (int, float)):
        return int(value["ID"])
    return None


def bool_value(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() == "on"
    if isinstance(value, (int, float)):
        return value != 0
    return None


@dataclass
class DeviceInfoData:
    ecu: int
    name: str
    model: str | None = None
    sw: str | None = None
    hw: str | None = None
    serial: str | None = None


@dataclass
class GatewayModel:
    """Everything learned at setup: devices, selected points, fields."""

    points: list[dict[str, Any]]
    fields: list[Field]
    devices: dict[int, DeviceInfoData] = field(default_factory=dict)
    # False when a datapoint was skipped; its entities must then be kept.
    complete: bool = True

    def field_by_key(self, key: str) -> Field | None:
        for f in self.fields:
            if f.key == key:
                return f
        return None

    def has(self, ecu: int, did: int) -> bool:
        return any(int(p["ecu"]) == ecu and int(p["did"]) == did for p in self.points)


def selection_signature(points: list[dict[str, Any]]) -> tuple:
    """What entities depend on: which points, their codec length and limits.
    Interval or topic changes do not change entities and are ignored."""
    import json

    return tuple(
        sorted(
            (
                int(p["ecu"]),
                int(p["did"]),
                int(p.get("len") or 0),
                json.dumps(p.get("range"), sort_keys=True),
            )
            for p in points
            if p.get("enabled", True)
        )
    )


def devices_from_system(system: dict[str, Any]) -> dict[int, DeviceInfoData]:
    out: dict[int, DeviceInfoData] = {}
    for dev in system.get("devices") or []:
        addr = dev.get("addr")
        if not isinstance(addr, int):
            continue
        out[addr] = DeviceInfoData(
            ecu=addr,
            name=dev.get("prop") or dev.get("name") or f"0x{addr:03x}",
            model=dev.get("prop"),
            sw=dev.get("sw"),
            hw=dev.get("hw"),
            serial=dev.get("ident") or None,
        )
    return out
