/*
 * open3e heat pump card — shipped with the open3e_gateway integration.
 *
 *   type: custom:open3e-heatpump-card
 *   title: Wärmepumpe                       # optional
 *   tiles: [circuit, compressor, ...]       # optional: which tiles, in which order
 *   normal_level_entity: input_number.x     # optional: marks a raised heating curve
 *   entities: { flow_hk: sensor.my_flow }   # optional: override any entity
 *
 * Entities are found through the integration (websocket open3e_gateway/entities),
 * so renamed entities keep working. No external libraries.
 */
const VERSION = "0.3.2";

// tile key -> integration entity key (unique id without the config entry prefix)
const KEYS = {
  circuit: "0x680_1415_Mode",
  compressor: "compressor_running",
  compressor_speed: "0x680_2346_value",
  flow_target: "0x680_987_value",
  flow_hk: "0x680_284_Actual",
  flow_wp: "0x680_268_Actual",
  return: "0x680_269_Actual",
  level: "0x680_880_Level",
  dhw: "0x680_271_Actual",
  dhw_set: "0x680_396_value",
  dhw_hyst_on: "0x680_1085_SetpointSwitchOn",
  dhw_charging: "0x680_1007_Required",
  one_time: "dhw_one_time_charge",
  heater: "heater_running",
  state: "operating_state",
  outside: "0x680_274_Actual",
  cop: "cop",
  errors: "0x680_265_value",
  power_el: "0x680_2488_value",
  power_th: "0x680_2496_value",
  el_heat_today: "0x680_548_Today",
  el_dhw_today: "0x680_565_Today",
  th_heat_today: "0x680_1211_Today",
  th_dhw_today: "0x680_1391_Today",
};

// flow_hk and dhw show actual / target in one tile; flow_target, dhw_set,
// return and heater can still be added through `tiles`.
const DEFAULT_TILES = ["circuit", "compressor", "flow_hk", "flow_wp", "level", "dhw", "one_time"];

const TEXT = {
  de: {
    title: "Wärmepumpe", circuit: "Heizkreis", compressor: "Verdichter", flow_target: "Vorlauf-Soll",
    flow_hk: "HK Vorlauf Ist/Soll", flow_wp: "WP Vorlauf", return: "Rücklauf", level: "Niveau", dhw: "Warmwasser Ist/Soll", today: "Ø heute",
    dhw_set: "WW-Soll", one_time: "Einmalladung", heater: "Heizstab", outside: "Außen", errors: "Fehler",
    power: "Leistung", on: "An", off: "Aus", missing: "Integration open3e Gateway nicht gefunden",
    modes: { Off: "Aus", Heating: "Heizen", Automatic: "Automatik", Cooling: "Kühlen",
             "Parallel Operation: Heating HotWater": "Heizen + WW", "Parallel Operation: Heating Cooling": "Heizen/Kühlen",
             TestMode: "Test" },
  },
  en: {
    title: "Heat pump", circuit: "Heating circuit", compressor: "Compressor", flow_target: "Flow target",
    flow_hk: "Circuit flow act/target", flow_wp: "Heat pump flow", return: "Return", level: "Curve level", dhw: "Hot water act/target", today: "today",
    dhw_set: "DHW target", one_time: "One-time charge", heater: "Heater", outside: "Outside", errors: "errors",
    power: "Power", on: "On", off: "Off", missing: "open3e Gateway integration not found", modes: {},
  },
};

const ICONS = {
  circuit: "mdi:radiator", compressor: "mdi:heat-pump", flow_target: "mdi:thermometer-check",
  flow_hk: "mdi:thermometer", flow_wp: "mdi:thermometer-high", return: "mdi:thermometer-low",
  level: "mdi:chart-bell-curve-cumulative", dhw: "mdi:water-thermometer", dhw_set: "mdi:water-boiler",
  one_time: "mdi:water-plus", heater: "mdi:heating-coil",
};

const C = {
  heat: "var(--deep-orange-color, #ff6f22)",
  water: "var(--blue-color, #2196f3)",
  ok: "var(--green-color, #4caf50)",
  warn: "var(--amber-color, #ffc107)",
  bad: "var(--red-color, #f44336)",
  off: "var(--disabled-color, #9e9e9e)",
  info: "var(--primary-color, #03a9f4)",
};

class Open3eHeatpumpCard extends HTMLElement {
  static getStubConfig() { return {}; }

  setConfig(config) {
    this._config = { ...(config || {}) };
    if (this._config.tiles && !Array.isArray(this._config.tiles)) throw new Error("tiles must be a list");
    this._sig = null;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._map && !this._loading) this._load();
    this._render();
  }

  getCardSize() { return 4; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  async _load() {
    this._loading = true;
    try {
      const res = await this._hass.callWS({ type: "open3e_gateway/entities" });
      const entries = res.entries || [];
      const entry = entries.find((e) => e.entry_id === this._config.entry_id) || entries[0];
      this._map = entry ? entry.entities : {};
      this._error = entry ? null : "missing";
    } catch (e) {
      this._map = {};
      this._error = "missing";
    }
    this._loading = false;
    this._sig = null;
    this._render();
  }

  _t() { return (this._hass?.locale?.language || this._hass?.language || "en").startsWith("de") ? TEXT.de : TEXT.en; }

  _id(tile) {
    const o = this._config.entities || {};
    return o[tile] || (this._map && this._map[KEYS[tile]]) || null;
  }

  _st(tile) { const id = this._id(tile); return id ? this._hass.states[id] : undefined; }

  _num(tile) { const s = this._st(tile); const v = s ? parseFloat(s.state) : NaN; return Number.isFinite(v) ? v : null; }

  _fmt(tile) {
    const s = this._st(tile);
    if (!s || ["unavailable", "unknown"].includes(s.state)) return "–";
    return this._hass.formatEntityState ? this._hass.formatEntityState(s) : `${s.state} ${s.attributes.unit_of_measurement || ""}`;
  }

  _n(x, digits = 1) {
    return x === null ? "–" : x.toLocaleString(this._hass.locale?.language || "en",
      { maximumFractionDigits: 1, minimumFractionDigits: digits });
  }

  _on(tile) { const s = this._st(tile); return s ? s.state === "on" : null; }

  _tile(tile) {
    const t = this._t();
    let value = this._fmt(tile);
    let color = C.info;
    let sub = "";
    const opState = this._st("state")?.state;
    switch (tile) {
      case "circuit": {
        const s = this._st("circuit");
        const id = s?.attributes?.id;
        value = s ? (t.modes[s.state] || s.state) : "–";
        color = id === 0 || s?.state === "Off" ? C.off : C.heat;
        break;
      }
      case "compressor": {
        const on = this._on("compressor");
        value = on === null ? "–" : on ? t.on : t.off;
        if (on && this._num("compressor_speed") !== null) value += ` · ${Math.round(this._num("compressor_speed"))} %`;
        color = on ? C.ok : C.off;
        break;
      }
      case "flow_target": color = C.heat; break;
      case "flow_hk": {
        const act = this._num("flow_hk"), target = this._num("flow_target");
        value = `${this._n(act)} / ${this._n(target)} °C`;
        const d = act !== null && target !== null ? act - target : null;
        color = d === null ? C.off : Math.abs(d) <= 2 ? C.ok : d < 0 ? C.water : C.heat;
        if (d !== null) sub = `${d > 0 ? "+" : ""}${d.toFixed(1)} K`;
        break;
      }
      case "flow_wp":
        color = opState === "heating" ? C.heat : opState === "dhw" ? C.water : C.off;
        break;
      case "level": {
        const lvl = this._num("level");
        const ne = this._config.normal_level_entity;
        const normal = ne && this._hass.states[ne] ? parseFloat(this._hass.states[ne].state) : null;
        if (lvl !== null) value = String(Math.round(lvl));
        if (normal !== null && Number.isFinite(normal) && lvl !== null && lvl !== normal) {
          color = C.warn;
          sub = `${lvl > normal ? "+" : ""}${Math.round(lvl - normal)}`;
        } else color = C.info;
        break;
      }
      case "dhw": {
        const v = this._num("dhw"), set = this._num("dhw_set"), hyst = this._num("dhw_hyst_on");
        value = `${this._n(v)} / ${this._n(set, 0)} °C`;
        const charging = this._on("dhw_charging") || opState === "dhw";
        if (charging) { color = C.water; sub = "lädt"; }
        else if (v !== null && set !== null && v < set - (hyst ?? 5)) color = C.bad;
        else color = v === null ? C.off : C.ok;
        if (t !== TEXT.de && sub) sub = "charging";
        break;
      }
      case "dhw_set": color = C.water; break;
      case "one_time": {
        const on = this._on("one_time");
        value = on === null ? "–" : on ? t.on : t.off;
        color = on ? C.water : C.off;
        break;
      }
      case "heater": {
        const on = this._on("heater");
        value = on === null ? "–" : on ? t.on : t.off;
        color = on ? C.bad : C.off;
        break;
      }
      case "return": color = C.info; break;
    }
    // The hot water tile opens the setpoint, which is the part that can be changed.
    const id = tile === "dhw" ? this._id("dhw_set") || this._id("dhw") : this._id(tile);
    return `<div class="tile${id ? " click" : ""}" data-entity="${id || ""}" style="--c:${color}">
      <div class="icon"><ha-icon icon="${ICONS[tile] || "mdi:information"}"></ha-icon></div>
      <div class="txt"><div class="val"><span>${value}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</div>
      <div class="name">${t[tile] || tile}</div></div></div>`;
  }

  _header() {
    const t = this._t();
    const st = this._st("state");
    const key = st?.state;
    const color = { heating: C.heat, dhw: C.water, heater: C.bad, standby: C.ok, off: C.off }[key] || C.off;
    const chip = st ? `<span class="chip" style="--c:${color}">${this._fmt("state")}</span>` : "";
    const cop = this._num("cop");
    // Daily COP from the heat pump's own energy counters (heating + hot water).
    const el = (this._num("el_heat_today") ?? 0) + (this._num("el_dhw_today") ?? 0);
    const th = (this._num("th_heat_today") ?? 0) + (this._num("th_dhw_today") ?? 0);
    const copDay = el > 0.5 ? th / el : null;
    // Colour from the daily value when there is one: the instantaneous COP swings
    // with defrosting, buffer charging and compressor load.
    const ref = copDay ?? cop;
    const copColor = ref === null ? C.off : ref >= 3.5 ? C.ok : ref >= 2.5 ? C.warn : C.bad;
    const errors = this._num("errors");
    const pe = this._num("power_el"), pt = this._num("power_th");
    const kw = (w) => (w / 1000).toLocaleString(this._hass.locale?.language || "en", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    const power = pe !== null && pt !== null && pe > 0
      ? `<span class="meta click" data-entity="${this._id("power_th") || ""}"><ha-icon icon="mdi:fire"></ha-icon>${kw(pt)} kW</span>
         <span class="meta click" data-entity="${this._id("power_el") || ""}"><ha-icon icon="mdi:flash"></ha-icon>${kw(pe)} kW</span>` : "";
    return `<div class="head">
      <div class="title">${this._config.title ?? t.title}${chip}</div>
      <div class="metas">
        ${errors ? `<span class="chip" style="--c:${C.bad}">${errors} ${t.errors}</span>` : ""}
        <span class="meta click" data-entity="${this._id("outside") || ""}"><ha-icon icon="mdi:thermometer"></ha-icon>${t.outside} ${this._fmt("outside")}</span>
        ${power}
        ${cop !== null || copDay !== null ? `<span class="chip click" data-entity="${this._id("cop") || ""}" style="--c:${copColor}">COP ${this._n(cop)}${copDay !== null ? ` · ${t.today} ${this._n(copDay)}` : ""}</span>` : ""}
      </div></div>`;
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const tiles = this._config.tiles || DEFAULT_TILES;
    const ids = [...new Set([...Object.keys(KEYS).map((k) => this._id(k)), this._config.normal_level_entity])].filter(Boolean);
    const sig = (this._error || "") + this._hass.language + ids.map((i) => {
      const s = this._hass.states[i]; return s ? s.state + s.last_updated : "-";
    }).join("|");
    if (sig === this._sig) return;
    this._sig = sig;
    const body = this._error
      ? `<div class="err">${this._t().missing}</div>`
      : !this._map ? "" : `${this._header()}<div class="grid">${tiles.filter((x) => KEYS[x] || ICONS[x]).map((x) => this._tile(x)).join("")}</div>`;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>${body}</ha-card>`;
    this.shadowRoot.querySelectorAll(".click").forEach((el) => {
      const entityId = el.dataset.entity;
      if (!entityId) return;
      el.addEventListener("click", () => {
        this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
      });
    });
  }
}

const STYLE = `
  ha-card { padding: 12px; }
  .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; }
  .title { font-size: 1.15em; font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .metas { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 0.9em; color: var(--secondary-text-color); }
  .meta { display: inline-flex; align-items: center; gap: 2px; }
  .meta ha-icon { --mdc-icon-size: 16px; }
  .chip { padding: 2px 10px; border-radius: 12px; font-size: 0.85em; font-weight: 500;
          color: var(--c); background: color-mix(in srgb, var(--c) 18%, transparent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
  .tile { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px;
          background: color-mix(in srgb, var(--c) 8%, var(--card-background-color, #fff));
          border: 1px solid color-mix(in srgb, var(--c) 25%, transparent); }
  .icon { flex: none; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
          color: var(--c); background: color-mix(in srgb, var(--c) 20%, transparent); }
  .txt { min-width: 0; }
  .val { font-size: 1.05em; font-weight: 600; display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 6px; }
  .val > span:first-child { white-space: nowrap; }
  .sub { font-size: 0.75em; font-weight: 500; color: var(--c); white-space: nowrap; }
  .name { font-size: 0.8em; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .click { cursor: pointer; }
  .err { color: var(--error-color, #db4437); padding: 8px; }
`;

if (!customElements.get("open3e-heatpump-card")) {
  customElements.define("open3e-heatpump-card", Open3eHeatpumpCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "open3e-heatpump-card",
    name: "open3e Wärmepumpe",
    description: "Heat pump overview: circuit, compressor, flow temperatures, curve level, hot water (open3e Gateway).",
    preview: true,
    documentationURL: "https://github.com/kienxux/ha-open3e-gateway",
  });
  console.info(`%c open3e-heatpump-card ${VERSION} `, "background:#ff6f22;color:#fff;border-radius:3px");
}
