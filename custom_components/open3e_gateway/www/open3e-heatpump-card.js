/*
 * open3e heat pump card — shipped with the open3e_gateway integration.
 *
 *   type: custom:open3e-heatpump-card
 *   title: Wärmepumpe                       # optional
 *   timeline: true                          # optional: operating state bar (default on)
 *   hours_to_show: 24                       # optional: time span of the bar
 *   temp_bar: true                          # optional: system diagram with flow/return (default on)
 *   tiles: [compressor, flow_hk, ...]       # optional: which tiles, in which order
 *   normal_level_entity: input_number.x     # optional: marks a raised heating curve
 *   entities: { flow_hk: sensor.my_flow }   # optional: override any entity
 *
 * Entities are found through the integration (websocket open3e_gateway/entities),
 * so renamed entities keep working. No external libraries. The card has a visual
 * editor (ha-form).
 */
const VERSION = "0.6.0";

// tile key -> integration entity key (unique id without the config entry prefix)
const KEYS = {
  circuit: "0x680_1415_Mode",
  compressor: "compressor_running",
  compressor_speed: "0x680_2346_value",
  flow_target: "0x680_987_value",
  flow_hk: "0x680_284_Actual",
  flow_wp: "0x680_268_Actual",
  return: "0x680_269_Actual",
  hk_return: "0x680_285_Actual",
  level: "0x680_880_Level",
  curve_slope: "0x680_880_Gradient",
  room_set: "0x680_424_Standard",
  flow_min: "0x680_1192_Minimum",
  flow_max: "0x680_1192_Maximum",
  climate: "heating_circuit",
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
const DEFAULT_TILES = ["level", "one_time"];
const DEFAULT_HOURS = 24;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;

const TEXT = {
  de: {
    title: "Wärmepumpe", circuit: "Heizkreis", compressor: "Verdichter", flow_target: "Vorlauf-Soll",
    flow_hk: "HK Vorlauf Ist/Soll", flow_wp: "WP Vorlauf", return: "Rücklauf", level: "Niveau", dhw: "Warmwasser Ist/Soll", today: "Ø heute",
    schema: "Anlagenschema", hp: "Wärmepumpe", house: "Haus", separator: "Weiche", target: "Soll",
    dhw_short: "Warmwasser", no_sensor: "kein Fühler", loop_hp: "Kreis Wärmepumpe", loop_house: "Heizkreis Haus",
    curve: "Heizkurve", outside_axis: "Außentemperatur", max: "Max", now_word: "jetzt", room: "Raum-Soll",
    slope: "Neigung", factor: "Faktor", c_base: "Fußpunkt", c_out: "Außen − Raum-Soll", c_result: "Vorlauf-Soll",
    c_controller: "Regler:", limit: "begrenzt auf",
    no_limit: "Max./Min.-Vorlauf (DID 1192) ist im Gateway nicht ausgewählt: Kurve ohne Begrenzung gezeichnet.", save: "Speichern", cancel: "Abbrechen",
    flow_word: "Vorlauf", return_word: "Rücklauf", charging: "lädt", dhw_ok: "bereit", dhw_low: "zu kalt",
    starts_below: "Ladung startet unter", level_slope: "Niveau · Neigung",
    dhw_set: "WW-Soll", one_time: "Einmalladung", heater: "Heizstab", outside: "Außen", errors: "Fehler",
    power: "Leistung", on: "An", off: "Aus", missing: "Integration open3e Gateway nicht gefunden", now: "jetzt",
    modes: { Off: "Aus", Heating: "Heizen", Automatic: "Automatik", Cooling: "Kühlen",
             "Parallel Operation: Heating HotWater": "Heizen + WW", "Parallel Operation: Heating Cooling": "Heizen/Kühlen",
             TestMode: "Test" },
  },
  en: {
    title: "Heat pump", circuit: "Heating circuit", compressor: "Compressor", flow_target: "Flow target",
    flow_hk: "Circuit flow act/target", flow_wp: "Heat pump flow", return: "Return", level: "Curve level", dhw: "Hot water act/target", today: "today",
    schema: "System diagram", hp: "Heat pump", house: "House", separator: "Separator", target: "Target",
    dhw_short: "Hot water", no_sensor: "no sensor", loop_hp: "Heat pump loop", loop_house: "House loop",
    curve: "Heating curve", outside_axis: "Outside temperature", max: "Max", now_word: "now", room: "room target",
    slope: "slope", factor: "factor", c_base: "Base", c_out: "Outside − room target", c_result: "Flow target",
    c_controller: "controller:", limit: "limited to",
    no_limit: "Max/min flow (DID 1192) is not selected on the gateway: curve drawn without the limit.", save: "Save", cancel: "Cancel",
    flow_word: "flow", return_word: "return", charging: "charging", dhw_ok: "ready", dhw_low: "too cold",
    starts_below: "Charging starts below", level_slope: "Curve level · slope",
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

// Every value from states, entity ids or the card config goes through esc() before
// it is put into markup (text or attribute).
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

  // Viessmann heating curve (matches the ViCare app and the controller's own flow
  // target 987): flow = room + level - slope * d * (1.4347 + 0.021 d + 247.9e-6 d^2),
  // d = outside - room. The result is limited to the circuit's min/max flow (1192).
  _curveCalc(at, room, level, slope) {
    const d = at - room;
    const factor = 1.4347 + 0.021 * d + 247.9e-6 * d * d;
    return { d, factor, raw: room + level - slope * d * factor };
  }

  _clamp(v) {
    const lo = this._num("flow_min"), hi = this._num("flow_max");
    if (hi !== null && v > hi) return hi;
    if (lo !== null && v < lo) return lo;
    return v;
  }

  _curve() {
    if (this._config.curve === false) return "";
    const t = this._t();
    const level0 = this._num("level");
    const slope0 = this._num("curve_slope") ?? (parseFloat(this._st("climate")?.attributes?.curve_gradient) || null);
    const room = this._num("room_set") ?? (parseFloat(this._st("climate")?.attributes?.room_setpoint_standard) || null);
    if (level0 === null || slope0 === null || room === null) return "";
    const dr = this._draft || {};
    const level = dr.level ?? level0, slope = dr.slope ?? slope0;
    const changed = level !== level0 || slope !== slope0;
    const outside = this._num("outside");
    const target = this._num("flow_target");
    const hi = this._num("flow_max");
    // Chart: outside +20 (left) .. -30 (right) like the ViCare app.
    const X0 = 44, X1 = 420, Y0 = 200, Y1 = 34;
    const pts = [20, 10, 0, -10, -20, -30];
    const val = (at, lv, sl) => this._clamp(this._curveCalc(at, room, lv, sl).raw);
    const all = [];
    for (let at = 20; at >= -30; at -= 2) all.push(val(at, level, slope), val(at, level0, slope0));
    const ymin = Math.floor((Math.min(...all) - 5) / 10) * 10, ymax = Math.ceil((Math.max(...all) + 5) / 10) * 10;
    const x = (at) => X0 + ((20 - at) / 50) * (X1 - X0);
    const y = (v) => Y0 - ((v - ymin) / (ymax - ymin)) * (Y0 - Y1);
    const line = (lv, sl) => { const a = []; for (let at = 20; at >= -30; at -= 1) a.push(`${x(at).toFixed(1)},${y(val(at, lv, sl)).toFixed(1)}`); return a; };
    const cur = line(level, slope);
    const grid = pts.map((at) => `<line x1="${x(at)}" y1="${Y1 - 6}" x2="${x(at)}" y2="${Y0}" class="gl"/>
      <text x="${x(at)}" y="${Y0 + 16}" text-anchor="middle" class="ax">${at > 0 ? "+" : ""}${at}°</text>`).join("");
    const yt = []; for (let v = ymin; v <= ymax; v += 10) yt.push(`<text x="${X0 - 8}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}°</text>`);
    const marks = pts.filter((at) => outside === null || Math.abs(at - outside) >= 3).map((at) => { const v = val(at, level, slope);
      return `<circle cx="${x(at)}" cy="${y(v)}" r="13" class="pt"/><text x="${x(at)}" y="${y(v) + 4}" text-anchor="middle" class="pv">${Math.round(v)}°</text>`; }).join("");
    let now = "", calc = "";
    if (outside !== null) {
      const c = this._curveCalc(outside, room, level, slope);
      const v = this._clamp(c.raw);
      const ox = x(Math.min(20, Math.max(-30, outside)));
      now = `<line x1="${ox}" y1="${Y1 - 6}" x2="${ox}" y2="${Y0}" class="nowl"/>
        <text x="${Math.min(Math.max(ox, X0 + 70), X1 - 70)}" y="${Y1 - 14}" text-anchor="middle" class="nowt">${esc(t.now_word)}: ${this._n(outside)}° → ${this._n(v)}°</text>`;
      const add = -slope * c.d * c.factor;
      const limited = Math.abs(v - c.raw) > 0.05;
      calc = `<div class="calc">
        <div><span class="n">1</span>${esc(t.c_base)}: ${esc(t.room)} ${this._n(room)} °C + ${esc(t.level)} ${this._n(level, 0)} = <b>${this._n(room + level)} °C</b></div>
        <div><span class="n">2</span>${esc(t.c_out)}: ${this._n(outside)} °C − ${this._n(room)} °C = ${this._n(c.d)} K → ${esc(t.slope)} ${this._n(slope)} × ${this._n(-c.d)} K × ${esc(t.factor)} ${c.factor.toFixed(3).replace(".", this._dec())} = <b>${add >= 0 ? "+" : ""}${this._n(add)} K</b></div>
        <div><span class="n">3</span>${esc(t.c_result)}: ${this._n(room + level)} ${add >= 0 ? "+" : "−"} ${this._n(Math.abs(add))} = <b>${this._n(c.raw)} °C</b>${limited ? ` → ${esc(t.limit)} <b>${this._n(v)} °C</b>` : ""}
          ${target !== null && !changed ? `<span class="ctl">${esc(t.c_controller)} ${this._n(target)} °C</span>` : ""}</div>
      </div>`;
    }
    // Controls: level is writable through its number entity; the slope only if it has one.
    const lvlId = this._id("level"), slId = this._id("curve_slope");
    const canLevel = lvlId && lvlId.startsWith("number.");
    const canSlope = slId && slId.startsWith("number.");
    const ctl = (key, label, value, can, digits) => `<div class="crow"><span>${esc(label)}</span>
      ${can ? `<button class="btn" data-act="${key}-">−</button>` : ""}<b>${this._n(value, digits)}</b>${can ? `<button class="btn" data-act="${key}+">+</button>` : ""}</div>`;
    return `<div class="curve">
      <div class="thead"><span>${esc(t.curve)}</span><span class="cap2">${esc(t.outside_axis)} →</span></div>
      <svg viewBox="0 0 440 222" role="img" aria-label="${esc(t.curve)}">
        ${grid}${yt.join("")}
        ${hi !== null ? `<line x1="${X0}" y1="${y(hi)}" x2="${X1}" y2="${y(hi)}" class="maxl"/><text x="${X0 + 4}" y="${y(hi) - 4}" class="ax">${esc(t.max)} ${this._n(hi, 0)}°</text>` : ""}
        ${changed ? `<polyline points="${line(level0, slope0).join(" ")}" class="old"/>` : ""}
        <polygon points="${X0},${Y0} ${cur.join(" ")} ${X1},${Y0}" class="area"/>
        <polyline points="${cur.join(" ")}" class="cl"/>
        ${now}${marks}${outside !== null ? `<circle cx="${x(Math.min(20, Math.max(-30, outside)))}" cy="${y(this._clamp(this._curveCalc(outside, room, level, slope).raw))}" r="6" class="nowp"/>` : ""}
      </svg>
      ${hi === null ? `<div class="note">${esc(t.no_limit)}</div>` : ""}
      ${calc}
      <div class="ctls">${ctl("slope", t.slope, slope, canSlope, 1)}${ctl("level", t.level, level, canLevel, 0)}
        ${changed ? `<button class="btn save" data-act="save">${esc(t.save)}</button><button class="btn" data-act="reset">${esc(t.cancel)}</button>` : ""}</div>
    </div>`;
  }

  _dec() { return (1.5).toLocaleString(this._hass.locale?.language || "en").charAt(1); }

  async _curveAction(act) {
    const level0 = this._num("level");
    const slope0 = this._num("curve_slope");
    const dr = this._draft || {};
    const lv = dr.level ?? level0, sl = dr.slope ?? slope0;
    const lim = (id, v) => { const a = this._hass.states[id]?.attributes || {};
      return Math.min(a.max ?? Infinity, Math.max(a.min ?? -Infinity, v)); };
    if (act === "level+" || act === "level-") dr.level = lim(this._id("level"), lv + (act === "level+" ? 1 : -1));
    else if (act === "slope+" || act === "slope-") dr.slope = Math.round(lim(this._id("curve_slope"), sl + (act === "slope+" ? 0.1 : -0.1)) * 10) / 10;
    else if (act === "reset") { this._draft = null; this._sig = null; this._render(); return; }
    else if (act === "save") {
      try {
        if (dr.level !== undefined && dr.level !== level0)
          await this._hass.callService("number", "set_value", { entity_id: this._id("level"), value: dr.level });
        if (dr.slope !== undefined && dr.slope !== slope0)
          await this._hass.callService("number", "set_value", { entity_id: this._id("curve_slope"), value: dr.slope });
        this._draft = null;
      } catch (e) {
        this._curveError = e.message || String(e);
      }
      this._sig = null; this._render(); return;
    }
    this._draft = dr; this._sig = null; this._render();
  }

  // System diagram: heat pump with two outputs. To the right the heating loop
  // through the hydraulic separator into the house, below the hot water loop into
  // the tank (the 3-way valve sends the water one way or the other). Flow pipes
  // orange, return pipes blue, moving dashes where water flows. The heat pump's
  // flow/return sensors (268/269) sit at the heat pump, so their values are shown
  // on whichever loop is active. The house return has no sensor on most systems.
  _schematic() {
    if (this._config.temp_bar === false) return "";
    const t = this._t();
    const hk = this._num("flow_hk"), target = this._num("flow_target"), wp = this._num("flow_wp"),
      ret = this._num("return"), hkRet = this._num("hk_return");
    if (hk === null && wp === null && ret === null) return "";
    const op = this._st("state")?.state;
    const comp = this._on("compressor");
    const dhwCharging = op === "dhw" || this._on("dhw_charging") === true;
    const dhwPath = op === "dhw";                // valve to the tank
    const circuitOn = this._st("circuit") ? this._st("circuit").state !== "Off" : true;
    const hpFlows = !!comp && !dhwPath, dhwFlows = !!comp && dhwPath;
    const d = hk !== null && target !== null ? hk - target : null;
    const dColor = d === null ? C.off : Math.abs(d) <= 2 ? C.ok : d < 0 ? C.water : C.heat;
    const deg = (v) => (v === null ? "–" : `${this._n(v)} °C`);
    const k = (x) => `${x > 0 ? "+" : ""}${this._n(x)} K`;
    const pipe = (pts, color, on, dashed = false) => `
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"
        opacity="${on ? 1 : 0.3}"${dashed ? ' stroke-dasharray="2 9"' : ""}/>
      ${on ? `<polyline class="flow" points="${pts}" fill="none"/>` : ""}`;
    const chip = (x, y, text, color, tile) => {
      const w = Math.max(48, text.length * 7.4 + 14);
      return `<g class="${tile && this._id(tile) ? "click" : ""}" data-entity="${esc(this._id(tile))}">
        <rect x="${x - w / 2}" y="${y - 11}" width="${w}" height="22" rx="11" fill="var(--card-background-color, #fff)" stroke="${color}" stroke-width="1.5"/>
        <text x="${x}" y="${y + 4.5}" text-anchor="middle" class="tv">${esc(text)}</text></g>`;
    };
    const hpSub = comp === null ? "" : comp
      ? `${esc(t.on)}${this._num("compressor_speed") !== null ? ` · ${Math.round(this._num("compressor_speed"))} %` : ""}` : t.off;
    const spread = wp !== null && ret !== null && comp ? wp - ret : null;
    // Hot water tank
    const tv = this._num("dhw"), tset = this._num("dhw_set"), hyst = this._num("dhw_hyst_on") ?? 5;
    const startBelow = tset !== null ? tset - hyst : null;
    const tankState = dhwCharging ? ["charging", C.water]
      : tv !== null && startBelow !== null && tv < startBelow ? ["dhw_low", C.bad] : ["dhw_ok", C.ok];
    // Fill level: empty 15 K below the setpoint, full at the setpoint.
    const fill = tv !== null && tset !== null ? Math.min(1, Math.max(0.08, (tv - (tset - 15)) / 15)) : 0;
    const oneTime = this._on("one_time");
    return `<div class="schema">
      <svg viewBox="0 0 440 268" role="img" aria-label="${esc(t.schema)}">
        <defs><clipPath id="o3e-tank"><rect x="150" y="176" width="100" height="86" rx="22"/></clipPath></defs>
        ${pipe("98,40 206,40", C.heat, hpFlows)}
        ${pipe("206,104 98,104", C.water, hpFlows)}
        ${pipe("226,40 338,40", C.heat, circuitOn)}
        ${pipe("338,104 226,104", C.water, circuitOn, hkRet === null)}
        ${pipe("74,126 74,200 150,200", C.heat, dhwFlows)}
        ${pipe("150,240 32,240 32,126", C.water, dhwFlows)}
        <g class="click" data-entity="${esc(this._id("compressor"))}">
          <rect x="6" y="18" width="92" height="108" rx="12" class="box" style="--c:${comp ? C.ok : C.off}"/>
          <text x="52" y="62" text-anchor="middle" class="bt">${esc(t.hp)}</text>
          <text x="52" y="80" text-anchor="middle" class="bs">${esc(hpSub)}</text>
          ${comp ? `<text x="52" y="98" text-anchor="middle" class="bs" style="fill:${dhwPath ? C.water : C.heat}">${dhwPath ? "↓ " + esc(t.dhw_short) : "→ " + esc(t.house)}</text>` : ""}
        </g>
        <rect x="206" y="14" width="20" height="116" rx="6" class="box" style="--c:${C.info}"/>
        <text x="216" y="145" text-anchor="middle" class="bs">${esc(t.separator)}</text>
        <g class="click" data-entity="${esc(this._id("level"))}">
          <polygon points="332,44 384,10 436,44" class="box" style="--c:${C.heat}"/>
          <rect x="340" y="40" width="88" height="86" rx="4" class="box" style="--c:${C.heat}"/>
          <text x="384" y="76" text-anchor="middle" class="bt">${esc(t.house)}</text>
          <text x="384" y="94" text-anchor="middle" class="bs">${esc(t.target)} ${deg(target)}</text>
          ${d !== null ? `<text x="384" y="112" text-anchor="middle" class="bs" style="fill:${dColor}">${k(d)}</text>` : ""}
        </g>
        <g class="click" data-entity="${esc(this._id("dhw_set") || this._id("dhw"))}">
          <rect x="150" y="176" width="100" height="86" rx="22" class="box" style="--c:${tankState[1]}"/>
          <rect x="150" y="${176 + 86 * (1 - fill)}" width="100" height="${86 * fill}" clip-path="url(#o3e-tank)"
            style="fill:color-mix(in srgb, ${tankState[1]} 22%, transparent)"/>
          <text x="200" y="196" text-anchor="middle" class="bs">${esc(t.dhw_short)}</text>
          <text x="200" y="219" text-anchor="middle" class="bt">${deg(tv)}</text>
          <text x="200" y="236" text-anchor="middle" class="bs">${esc(t.target)} ${deg(tset)}</text>
          <text x="200" y="253" text-anchor="middle" class="bs" style="fill:${tankState[1]}">${esc(t[tankState[0]])}</text>
        </g>
        ${startBelow !== null ? `<text x="264" y="204" class="cap">${esc(t.starts_below)} ${deg(startBelow)}</text>` : ""}
        ${oneTime !== null ? `<g class="click" data-entity="${esc(this._id("one_time"))}"><text x="264" y="226" class="cap">${esc(t.one_time)}:
          <tspan style="fill:${oneTime ? C.water : "var(--secondary-text-color)"};font-weight:600">${oneTime ? t.on : t.off}</tspan></text></g>` : ""}
        ${dhwPath ? `
          ${chip(112, 200, deg(wp), C.heat, "flow_wp")}
          ${chip(91, 240, deg(ret), C.water, "return")}
          ${spread !== null ? `<text x="112" y="224" text-anchor="middle" class="bs">Δ ${this._n(spread)} K</text>` : ""}` : `
          ${chip(152, 40, deg(wp), C.heat, "flow_wp")}
          ${chip(152, 104, deg(ret), C.water, "return")}
          ${spread !== null ? `<text x="152" y="76" text-anchor="middle" class="bs">Δ ${this._n(spread)} K</text>` : ""}`}
        ${chip(282, 40, deg(hk), C.heat, "flow_hk")}
        ${chip(282, 104, hkRet === null ? t.no_sensor : deg(hkRet), C.water, hkRet === null ? null : "hk_return")}
        <text x="152" y="14" text-anchor="middle" class="cap">${esc(t.loop_hp)}</text>
        <text x="282" y="14" text-anchor="middle" class="cap">${esc(t.loop_house)}</text>
        <text x="282" y="77" text-anchor="middle" class="cap">${esc(t.flow_word)} ↑ · ${esc(t.return_word)} ↓</text>
      </svg></div>`;
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
        title="${esc(text)}: ${time(g.from)}–${time(g.to)} (${dur(g.to - g.from)})">${width >= 7 ? `<span>${esc(text)}</span>` : ""}</div>`;
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
    return `<div class="timeline click" data-entity="${esc(id)}">
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
        // Slope from its own entity, or from the climate entity's attribute.
        const slope = this._num("curve_slope") ?? parseFloat(this._st("climate")?.attributes?.curve_gradient);
        if (lvl !== null) value = String(Math.round(lvl)) + (Number.isFinite(slope) ? ` · ${this._n(slope)}` : "");
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
    return `<div class="tile${id ? " click" : ""}" data-entity="${esc(id)}" style="--c:${color}">
      <div class="icon"><ha-icon icon="${ICONS[tile] || "mdi:information"}"></ha-icon></div>
      <div class="txt"><div class="val"><span>${esc(value)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>
      <div class="name">${esc(tile === "level" ? t.level_slope : t[tile] || tile)}</div></div></div>`;
  }

  _header() {
    const t = this._t();
    const st = this._st("state");
    const key = st?.state;
    const color = STATE_COLOR[key] || C.off;
    const chip = st ? `<span class="chip" style="--c:${color}">${esc(this._fmt("state"))}</span>` : "";
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
      ? `<span class="meta click" data-entity="${esc(this._id("power_th"))}"><ha-icon icon="mdi:fire"></ha-icon>${kw(pt)} kW</span>
         <span class="meta click" data-entity="${esc(this._id("power_el"))}"><ha-icon icon="mdi:flash"></ha-icon>${kw(pe)} kW</span>` : "";
    return `<div class="head">
      <div class="title">${esc(this._config.title ?? t.title)}${chip}</div>
      <div class="metas">
        ${errors ? `<span class="chip" style="--c:${C.bad}">${esc(errors)} ${t.errors}</span>` : ""}
        <span class="meta click" data-entity="${esc(this._id("outside"))}"><ha-icon icon="mdi:thermometer"></ha-icon>${t.outside} ${esc(this._fmt("outside"))}</span>
        ${power}
        ${cop !== null || copDay !== null ? `<span class="chip click" data-entity="${esc(this._id("cop"))}" style="--c:${copColor}">COP ${this._n(cop)}${copDay !== null ? ` · ${t.today} ${this._n(copDay)}` : ""}</span>` : ""}
      </div></div>`;
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const tiles = this._config.tiles || DEFAULT_TILES;
    const ids = [...new Set([...Object.keys(KEYS).map((k) => this._id(k)), this._config.normal_level_entity])].filter(Boolean);
    const sig = (this._error || "") + JSON.stringify(this._draft || null) + (this._curveError || "") + this._hass.language + (this._hist ? this._hist.length : "-")
      + Math.floor(Date.now() / 60000) + ids.map((i) => {
      const s = this._hass.states[i]; return s ? s.state + s.last_updated : "-";
    }).join("|");
    if (sig === this._sig) return;
    this._sig = sig;
    const body = this._error
      ? `<div class="err">${this._t().missing}</div>`
      : !this._map ? "" : `${this._header()}${this._timeline()}${this._schematic()}${this._curve()}<div class="grid">${tiles.filter((x) => KEYS[x] || ICONS[x]).map((x) => this._tile(x)).join("")}</div>`;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>${body}</ha-card>`;
    this.shadowRoot.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", (ev) => { ev.stopPropagation(); this._curveAction(el.dataset.act); });
    });
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
  .curve { margin-bottom: 10px; padding: 8px 10px; border-radius: 12px;
           border: 1px solid color-mix(in srgb, var(--disabled-color, #9e9e9e) 25%, transparent); }
  .curve svg { display: block; width: 100%; height: auto; overflow: visible; }
  .curve .gl { stroke: var(--divider-color, #ccc); stroke-dasharray: 4 4; }
  .curve .ax { font-size: 11px; fill: var(--secondary-text-color); }
  .curve .area { fill: color-mix(in srgb, ${C.heat} 14%, transparent); }
  .curve .cl { fill: none; stroke: ${C.heat}; stroke-width: 2.5; }
  .curve .old { fill: none; stroke: var(--secondary-text-color); stroke-width: 1.5; stroke-dasharray: 5 4; }
  .curve .maxl { stroke: ${C.bad}; stroke-width: 1; stroke-dasharray: 2 4; }
  .curve .pt { fill: var(--card-background-color, #fff); stroke: ${C.heat}; stroke-width: 2; }
  .curve .pv { font-size: 10.5px; font-weight: 600; fill: var(--primary-text-color); }
  .curve .nowl { stroke: ${C.info}; stroke-width: 1.5; stroke-dasharray: 3 3; }
  .curve .nowp { fill: ${C.info}; stroke: var(--card-background-color, #fff); stroke-width: 2; }
  .curve .nowt { font-size: 12px; font-weight: 600; fill: ${C.info}; }
  .curve .thead { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 0.9em; font-weight: 500; }
  .curve .cap2 { font-size: 0.8em; color: var(--secondary-text-color); font-weight: 400; }
  .note { font-size: 0.75em; color: ${C.warn}; margin-top: 2px; }
  .calc { font-size: 0.82em; display: grid; gap: 4px; margin: 6px 0 8px; color: var(--secondary-text-color); }
  .calc b { color: var(--primary-text-color); }
  .calc .n { display: inline-flex; width: 16px; height: 16px; border-radius: 50%; align-items: center; justify-content: center;
             font-size: 0.8em; margin-right: 6px; color: #fff; background: ${C.info}; }
  .calc .ctl { margin-left: 8px; color: ${C.ok}; }
  .ctls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; }
  .crow { display: inline-flex; align-items: center; gap: 8px; }
  .crow b { min-width: 28px; text-align: center; }
  .btn { border: none; border-radius: 14px; min-width: 28px; height: 28px; padding: 0 8px; cursor: pointer; font: inherit; font-weight: 600;
         color: var(--primary-text-color); background: color-mix(in srgb, var(--primary-text-color) 10%, transparent); }
  .btn.save { color: #fff; background: ${C.heat}; padding: 0 14px; }
  .schema { margin-bottom: 10px; padding: 4px 4px 0; border-radius: 12px;
            border: 1px solid color-mix(in srgb, var(--disabled-color, #9e9e9e) 25%, transparent); }
  .schema svg { display: block; width: 100%; height: auto; overflow: visible; }
  .schema .box { fill: color-mix(in srgb, var(--c) 12%, var(--card-background-color, #fff));
                 stroke: color-mix(in srgb, var(--c) 55%, transparent); stroke-width: 1.5; }
  .schema text { fill: var(--primary-text-color); font-family: inherit; }
  .schema .bt { font-size: 14px; font-weight: 600; }
  .schema .bs { font-size: 12.5px; fill: var(--secondary-text-color); }
  .schema .tv { font-size: 13px; font-weight: 600; }
  .schema .cap { font-size: 11.5px; fill: var(--secondary-text-color); letter-spacing: 0.02em; }
  .schema .flow { stroke: rgba(255, 255, 255, 0.85); stroke-width: 2.5; stroke-linecap: round;
                  stroke-dasharray: 3 11; animation: o3e-flow 1.2s linear infinite; }
  @keyframes o3e-flow { to { stroke-dashoffset: -14; } }
  @media (prefers-reduced-motion: reduce) { .schema .flow { animation: none; } }
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
    title: "Titel", temp_bar: "Anlagenschema (Vor-/Rücklauf) anzeigen", curve: "Heizkurve anzeigen", timeline: "Verlauf Betriebszustand anzeigen", hours_to_show: "Stunden im Verlauf",
    tiles: "Kacheln (Reihenfolge per Ziehen)", normal_level_entity: "Normales Heizkurven-Niveau (Helfer)",
    entities: "Entitäten überschreiben (optional)", state: "Betriebszustand",
  },
  en: {
    title: "Title", temp_bar: "Show system diagram (flow/return)", curve: "Show heating curve", timeline: "Show operating state timeline", hours_to_show: "Hours in timeline",
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
      { name: "curve", selector: { boolean: {} } },
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
    this._form.data = { timeline: true, temp_bar: true, curve: true, hours_to_show: DEFAULT_HOURS, tiles: DEFAULT_TILES, ...this._config };
  }

  _changed(value) {
    const cfg = { ...this._config, ...value };
    // Keep the YAML short: drop defaults and empty values.
    if (cfg.timeline === true) delete cfg.timeline;
    if (cfg.temp_bar === true) delete cfg.temp_bar;
    if (cfg.curve === true) delete cfg.curve;
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
