/*
 * open3e heat pump card — shipped with the open3e_gateway integration.
 *
 *   type: custom:open3e-heatpump-card
 *   title: Wärmepumpe                       # optional
 *   timeline: true                          # optional: operating state bar (default on)
 *   hours_to_show: 24                       # optional: time span of the bar
 *   temp_bar: true                          # optional: flow/return range bar (default on)
 *   tiles: [compressor, flow_hk, ...]       # optional: which tiles, in which order
 *   normal_level_entity: input_number.x     # optional: marks a raised heating curve
 *   entities: { flow_hk: sensor.my_flow }   # optional: override any entity
 *
 * Entities are found through the integration (websocket open3e_gateway/entities),
 * so renamed entities keep working. No external libraries. The card has a visual
 * editor (ha-form).
 */
const VERSION = "0.5.0";

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
// The circuit tile was replaced by the operating state timeline, the flow tiles by the
// temperature bar; all of them can still be added.
const DEFAULT_TILES = ["compressor", "level", "dhw", "one_time"];
const DEFAULT_HOURS = 24;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;

const TEXT = {
  de: {
    title: "Wärmepumpe", circuit: "Heizkreis", compressor: "Verdichter", flow_target: "Vorlauf-Soll",
    flow_hk: "HK Vorlauf Ist/Soll", flow_wp: "WP Vorlauf", return: "Rücklauf", level: "Niveau", dhw: "Warmwasser Ist/Soll", today: "Ø heute",
    temps: "Vorlauf / Rücklauf", spread: "Spreizung", hk: "HK", wp: "WP", target: "Soll",
    dhw_set: "WW-Soll", one_time: "Einmalladung", heater: "Heizstab", outside: "Außen", errors: "Fehler",
    power: "Leistung", on: "An", off: "Aus", missing: "Integration open3e Gateway nicht gefunden", now: "jetzt",
    modes: { Off: "Aus", Heating: "Heizen", Automatic: "Automatik", Cooling: "Kühlen",
             "Parallel Operation: Heating HotWater": "Heizen + WW", "Parallel Operation: Heating Cooling": "Heizen/Kühlen",
             TestMode: "Test" },
  },
  en: {
    title: "Heat pump", circuit: "Heating circuit", compressor: "Compressor", flow_target: "Flow target",
    flow_hk: "Circuit flow act/target", flow_wp: "Heat pump flow", return: "Return", level: "Curve level", dhw: "Hot water act/target", today: "today",
    temps: "Flow / return", spread: "Spread", hk: "Circuit", wp: "Heat pump", target: "Target",
    dhw_set: "DHW target", one_time: "One-time charge", heater: "Heater", outside: "Outside", errors: "errors",
    power: "Power", on: "On", off: "Off", missing: "open3e Gateway integration not found", now: "now", modes: {},
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

// Operating state -> colour, shared by the header chip and the timeline.
const STATE_COLOR = { heating: C.heat, dhw: C.water, heater: C.bad, standby: C.ok, off: C.off };

class Open3eHeatpumpCard extends HTMLElement {
  static getStubConfig() { return {}; }

  static async getConfigElement() {
    await ensureHaForm();
    return document.createElement("open3e-heatpump-card-editor");
  }

  setConfig(config) {
    this._config = { ...(config || {}) };
    if (this._config.tiles && !Array.isArray(this._config.tiles)) throw new Error("tiles must be a list");
    const h = this._config.hours_to_show;
    if (h !== undefined && !(Number(h) > 0)) throw new Error("hours_to_show must be a positive number");
    this._hist = null;
    this._histKey = null;
    this._sig = null;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._map && !this._loading) this._load();
    this._render();
  }

  connectedCallback() {
    // Redraw once a minute so the bar moves on, and reload the history now and then.
    this._timer = setInterval(() => {
      if (this._histAt && Date.now() - this._histAt > HISTORY_REFRESH_MS) this._histKey = null;
      this._render();
    }, 60 * 1000);
    if (this._hass) this._render();
  }

  disconnectedCallback() { clearInterval(this._timer); }

  _hours() { return Number(this._config.hours_to_show) > 0 ? Number(this._config.hours_to_show) : DEFAULT_HOURS; }

  _showTimeline() { return this._config.timeline !== false; }

  // Live range bar: return -> heat pump flow as a band (= spread), circuit flow as a
  // dot, the circuit flow target as a tick.
  _tempBar() {
    if (this._config.temp_bar === false) return "";
    const t = this._t();
    const hk = this._num("flow_hk"), target = this._num("flow_target"), wp = this._num("flow_wp"), ret = this._num("return");
    const vals = [hk, target, wp, ret].filter((v) => v !== null);
    if (!vals.length) return "";
    // Scale in 5 K steps around the values, at least 20 K wide.
    let lo = Math.floor((Math.min(...vals) - 3) / 5) * 5, hi = Math.ceil((Math.max(...vals) + 3) / 5) * 5;
    while (hi - lo < 20) { lo -= 5; if (hi - lo < 20) hi += 5; }
    const pos = (v) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
    const opState = this._st("state")?.state;
    const bandColor = opState === "dhw" ? C.water : opState === "heating" ? C.heat : C.off;
    const d = hk !== null && target !== null ? hk - target : null;
    const hkColor = d === null ? C.off : Math.abs(d) <= 2 ? C.ok : d < 0 ? C.water : C.heat;
    // The spread only means something while the compressor runs.
    const spread = wp !== null && ret !== null && this._on("compressor") ? wp - ret : null;
    const k = (x) => `${x > 0 ? "+" : ""}${this._n(x)} K`;
    const step = hi - lo > 40 ? 10 : 5;
    const scale = [];
    for (let v = lo; v <= hi; v += step) scale.push(`<span style="left:${pos(v)}%">${v}°</span>`);
    const band = wp !== null && ret !== null
      ? `<div class="band" style="left:${pos(Math.min(ret, wp))}%;width:${Math.abs(pos(wp) - pos(ret))}%;--c:${bandColor}"></div>` : "";
    const tick = target !== null ? `<div class="tick" style="left:${pos(target)}%"></div>` : "";
    const dot = hk !== null ? `<div class="dot" style="left:${pos(hk)}%;--c:${hkColor}"></div>` : "";
    const item = (tile, sym, label, v, color) => v === null ? "" :
      `<span class="li click" data-entity="${this._id(tile) || ""}"><i class="${sym}" style="--c:${color}"></i>${label} ${this._n(v)} °C</span>`;
    return `<div class="temps">
      <div class="thead"><span>${t.temps}</span><span class="tmeta">
        ${spread !== null ? `<span class="click" data-entity="${this._id("flow_wp") || ""}">${t.spread} ${this._n(spread)} K</span>` : ""}
        ${d !== null ? `<span class="chip" style="--c:${hkColor}">${t.hk} ${k(d)}</span>` : ""}</span></div>
      <div class="track click" data-entity="${this._id("flow_hk") || ""}">${band}${tick}${dot}</div>
      <div class="scale">${scale.join("")}</div>
      <div class="legend">
        ${item("flow_hk", "s-dot", t.hk, hk, hkColor)}
        ${item("flow_target", "s-tick", t.target, target, "var(--primary-text-color)")}
        ${item("flow_wp", "s-band", t.wp, wp, bandColor)}
        ${item("return", "s-band", t.return, ret, C.water)}
      </div></div>`;
  }

  // Loads the state history of the operating state sensor (needs the recorder).
  async _loadHistory(id) {
    const key = `${id}|${this._hours()}`;
    if (this._histKey === key || this._histLoading) return;
    this._histLoading = true;
    this._histKey = key;
    const start = new Date(Date.now() - this._hours() * 3600 * 1000);
    try {
      const res = await this._hass.callWS({
        type: "history/history_during_period", start_time: start.toISOString(), entity_ids: [id],
        minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
      this._hist = (res[id] || []).map((e) => ({ s: e.s, t: 1000 * (e.lc ?? e.lu) }));
    } catch (e) {
      this._hist = [];
    }
    this._histAt = Date.now();
    this._histLoading = false;
    this._sig = null;
    this._render();
  }

  // Segments [{s, from, to}] over the shown period, merged, with the live state at the end.
  _segments(id) {
    const now = Date.now();
    const start = now - this._hours() * 3600 * 1000;
    const pts = [...(this._hist || [])];
    const cur = this._hass.states[id];
    if (cur) {
      const t = new Date(cur.last_changed).getTime();
      if (!pts.length || pts[pts.length - 1].s !== cur.state) pts.push({ s: cur.state, t: Math.max(t, pts.length ? pts[pts.length - 1].t : t) });
    }
    const segs = [];
    pts.forEach((p, i) => {
      const from = Math.max(p.t, start);
      const to = i + 1 < pts.length ? Math.min(pts[i + 1].t, now) : now;
      if (to <= from) return;
      const last = segs[segs.length - 1];
      if (last && last.s === p.s) last.to = to;
      else segs.push({ s: p.s, from, to });
    });
    return { segs, start, now };
  }

  _timeline() {
    const id = this._id("state");
    if (!id || !this._showTimeline()) return "";
    this._loadHistory(id);
    const { segs, start, now } = this._segments(id);
    const span = now - start;
    const lang = this._hass.locale?.language || "en";
    const time = (ms) => new Date(ms).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
    const dur = (ms) => {
      const m = Math.round(ms / 60000);
      return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
    };
    const stateObj = this._hass.states[id];
    const label = (s) => ["unavailable", "unknown"].includes(s) ? "–"
      : stateObj && this._hass.formatEntityState ? this._hass.formatEntityState(stateObj, s) : s;
    const bars = segs.map((g) => {
      const left = ((g.from - start) / span) * 100, width = ((g.to - g.from) / span) * 100;
      const color = STATE_COLOR[g.s] || C.off;
      const text = label(g.s);
      return `<div class="seg" style="left:${left}%;width:${width}%;--c:${color}"
        title="${text}: ${time(g.from)}–${time(g.to)} (${dur(g.to - g.from)})">${width >= 7 ? `<span>${text}</span>` : ""}</div>`;
    }).join("");
    // Axis: full hours, at most about five labels.
    const hours = this._hours();
    const step = [1, 2, 3, 4, 6, 12, 24, 48].find((x) => hours / x <= 5) || Math.ceil(hours / 5);
    const ticks = [];
    const first = new Date(start); first.setMinutes(0, 0, 0); first.setHours(first.getHours() + 1);
    for (let t = first.getTime(); t < now; t += 3600 * 1000) {
      const d = new Date(t);
      const pos = ((t - start) / span) * 100;
      if (d.getHours() % step === 0 && pos > 4 && pos < 92) ticks.push(`<span style="left:${pos}%">${time(t)}</span>`);
    }
    return `<div class="timeline click" data-entity="${id}">
      <div class="bar">${bars}</div>
      <div class="axis">${ticks.join("")}<span class="end">${this._t().now}</span></div></div>`;
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
    const color = STATE_COLOR[key] || C.off;
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
    const sig = (this._error || "") + this._hass.language + (this._hist ? this._hist.length : "-")
      + Math.floor(Date.now() / 60000) + ids.map((i) => {
      const s = this._hass.states[i]; return s ? s.state + s.last_updated : "-";
    }).join("|");
    if (sig === this._sig) return;
    this._sig = sig;
    const body = this._error
      ? `<div class="err">${this._t().missing}</div>`
      : !this._map ? "" : `${this._header()}${this._timeline()}${this._tempBar()}<div class="grid">${tiles.filter((x) => KEYS[x] || ICONS[x]).map((x) => this._tile(x)).join("")}</div>`;
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
  .timeline { margin-bottom: 10px; }
  .bar { position: relative; height: 26px; border-radius: 8px; overflow: hidden;
         background: color-mix(in srgb, var(--disabled-color, #9e9e9e) 15%, transparent); }
  .seg { position: absolute; top: 0; bottom: 0; display: flex; align-items: center; justify-content: center;
         background: color-mix(in srgb, var(--c) 75%, var(--card-background-color, #fff));
         box-shadow: inset -1px 0 0 var(--card-background-color, #fff); overflow: hidden; }
  .seg span { font-size: 0.78em; font-weight: 500; color: #fff; padding: 0 4px;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .axis { position: relative; height: 14px; margin-top: 2px; font-size: 0.72em; color: var(--secondary-text-color); }
  .axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .axis span.end { right: 0; transform: none; }
  .temps { margin-bottom: 10px; padding: 8px 10px 4px; border-radius: 12px;
           border: 1px solid color-mix(in srgb, var(--disabled-color, #9e9e9e) 25%, transparent); }
  .thead { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 0.9em; font-weight: 500; margin-bottom: 8px; }
  .tmeta { display: flex; align-items: center; gap: 8px; font-weight: 400; color: var(--secondary-text-color); font-size: 0.95em; }
  .track { position: relative; height: 10px; border-radius: 5px; margin: 0 6px;
           background: color-mix(in srgb, var(--disabled-color, #9e9e9e) 20%, transparent); }
  .band { position: absolute; top: 0; bottom: 0; border-radius: 5px; min-width: 3px;
          background: linear-gradient(90deg, var(--blue-color, #2196f3), var(--c)); }
  .tick { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--primary-text-color); }
  .dot { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
         background: var(--c); box-shadow: 0 0 0 2px var(--card-background-color, #fff); }
  .scale { position: relative; height: 14px; margin: 3px 6px 0; font-size: 0.7em; color: var(--secondary-text-color); }
  .scale span { position: absolute; transform: translateX(-50%); }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 0.8em; margin-top: 4px; }
  .li { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .li i { display: inline-block; background: var(--c); }
  .s-dot { width: 10px; height: 10px; border-radius: 50%; }
  .s-tick { width: 2px; height: 12px; }
  .s-band { width: 14px; height: 6px; border-radius: 3px; }
`;

// ha-form is only defined once HA has loaded it; an entities card editor pulls it in.
async function ensureHaForm() {
  if (customElements.get("ha-form")) return;
  try {
    const helpers = await window.loadCardHelpers();
    const card = await helpers.createCardElement({ type: "entities", entities: [] });
    await card.constructor.getConfigElement();
  } catch (e) { /* the editor falls back to YAML if ha-form is missing */ }
}

const EDITOR_TEXT = {
  de: {
    title: "Titel", temp_bar: "Vorlauf/Rücklauf-Balken anzeigen", timeline: "Verlauf Betriebszustand anzeigen", hours_to_show: "Stunden im Verlauf",
    tiles: "Kacheln (Reihenfolge per Ziehen)", normal_level_entity: "Normales Heizkurven-Niveau (Helfer)",
    entities: "Entitäten überschreiben (optional)", state: "Betriebszustand",
  },
  en: {
    title: "Title", temp_bar: "Show flow/return bar", timeline: "Show operating state timeline", hours_to_show: "Hours in timeline",
    tiles: "Tiles (drag to reorder)", normal_level_entity: "Normal curve level (helper)",
    entities: "Override entities (optional)", state: "Operating state",
  },
};

const TILE_CHOICES = ["compressor", "level", "dhw", "one_time", "flow_hk", "flow_wp", "return", "flow_target", "circuit", "dhw_set", "heater"];

class Open3eHeatpumpCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...(config || {}) };
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  _lang() { return (this._hass?.locale?.language || this._hass?.language || "en").startsWith("de") ? "de" : "en"; }

  _schema() {
    const t = TEXT[this._lang()];
    return [
      { name: "title", selector: { text: {} } },
      { type: "grid", name: "", schema: [
        { name: "timeline", selector: { boolean: {} } },
        { name: "hours_to_show", selector: { number: { min: 1, max: 168, step: 1, mode: "box", unit_of_measurement: "h" } } },
      ] },
      { name: "temp_bar", selector: { boolean: {} } },
      { name: "tiles", selector: { select: { multiple: true, reorder: true,
        options: TILE_CHOICES.map((k) => ({ value: k, label: t[k] || k })) } } },
      { name: "normal_level_entity", selector: { entity: { domain: ["input_number", "number"] } } },
      { type: "expandable", name: "entities", title: EDITOR_TEXT[this._lang()].entities, schema:
        ["state", ...TILE_CHOICES, "compressor_speed", "dhw_hyst_on", "dhw_charging", "outside", "cop", "power_el", "power_th"]
          .map((k) => ({ name: k, selector: { entity: {} } })) },
    ];
  }

  _update() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_TEXT[this._lang()][s.name] || TEXT[this._lang()][s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => this._changed(ev.detail.value));
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = this._schema();
    this._form.data = { timeline: true, temp_bar: true, hours_to_show: DEFAULT_HOURS, tiles: DEFAULT_TILES, ...this._config };
  }

  _changed(value) {
    const cfg = { ...this._config, ...value };
    // Keep the YAML short: drop defaults and empty values.
    if (cfg.timeline === true) delete cfg.timeline;
    if (cfg.temp_bar === true) delete cfg.temp_bar;
    if (Number(cfg.hours_to_show) === DEFAULT_HOURS || cfg.hours_to_show === undefined || cfg.hours_to_show === null) delete cfg.hours_to_show;
    if (Array.isArray(cfg.tiles) && cfg.tiles.join() === DEFAULT_TILES.join()) delete cfg.tiles;
    if (!cfg.title) delete cfg.title;
    if (!cfg.normal_level_entity) delete cfg.normal_level_entity;
    if (cfg.entities) {
      const e = Object.fromEntries(Object.entries(cfg.entities).filter(([, v]) => v));
      if (Object.keys(e).length) cfg.entities = e; else delete cfg.entities;
    }
    this._config = cfg;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: cfg }, bubbles: true, composed: true }));
  }
}

if (!customElements.get("open3e-heatpump-card-editor")) customElements.define("open3e-heatpump-card-editor", Open3eHeatpumpCardEditor);

if (!customElements.get("open3e-heatpump-card")) {
  customElements.define("open3e-heatpump-card", Open3eHeatpumpCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "open3e-heatpump-card",
    name: "open3e Wärmepumpe",
    description: "Heat pump overview: operating state timeline, compressor, flow temperatures, curve level, hot water (open3e Gateway).",
    preview: true,
    documentationURL: "https://github.com/kienxux/ha-open3e-gateway",
  });
  console.info(`%c open3e-heatpump-card ${VERSION} `, "background:#ff6f22;color:#fff;border-radius:3px");
}
