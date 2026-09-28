/**
 * unit-converter — the official minimal KAEL plugin example.
 *
 * Plain DOM. No framework, no build step, no imports. Theme-reactive via the
 * app's CSS variables, so it matches whichever KAEL theme is active.
 *
 * Contract (see PLUGIN-AUTHORING.md at the root of the main KAEL repo):
 *   export function mount(container, kaelApi)
 *   export function unmount(container)   // optional, recommended
 *
 * Declared permissions (manifest.json): ["app.info"] — that is ALL this
 * plugin can call. Touching anything else on kaelApi (fs, processes, net…)
 * throws a permission error naming this plugin and what it declared.
 */

const CATEGORIES = {
  length: ["m", "km", "cm", "mm", "mi", "yd", "ft", "in"],
  mass: ["kg", "g", "mg", "t", "lb", "oz"],
  temp: ["C", "F", "K"],
};

const RATES = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254 },
  mass: { kg: 1, g: 0.001, mg: 1e-6, t: 1000, lb: 0.45359237, oz: 0.028349523125 },
};

function toCelsius(v, from) {
  if (from === "F") return (v - 32) * (5 / 9);
  if (from === "K") return v - 273.15;
  return v;
}

function fromCelsius(c, to) {
  if (to === "F") return c * (9 / 5) + 32;
  if (to === "K") return c + 273.15;
  return c;
}

function convert(cat, from, to, v) {
  if (cat === "temp") return fromCelsius(toCelsius(v, from), to);
  const f = RATES[cat][from];
  const t = RATES[cat][to];
  if (f === undefined || t === undefined) return NaN;
  return (v * f) / t;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 0.001 || abs >= 1e9)) return n.toExponential(4);
  return String(Math.round(n * 1e6) / 1e6);
}

export async function mount(container, kaelApi) {
  /* The ONE bridge call this plugin makes — granted via the "app.info"
   * permission. Remove it (and the permission) and the plugin still works. */
  let footer = "app info unavailable";
  try {
    const info = await kaelApi.runtime.info();
    footer = "kael " + info.appVersion + " · " + info.platform + "/" + info.arch + " · electron " + info.electron;
  } catch (err) {
    footer = "app info refused: " + ((err && err.message) || err);
  }

  const root = document.createElement("div");
  root.className = "uc-root";
  root.setAttribute("data-kael-plugin", "unit-converter");

  const head = document.createElement("div");
  head.className = "uc-head";
  head.textContent = "unit converter";

  const cat = document.createElement("select");
  cat.className = "uc-select";
  cat.setAttribute("aria-label", "category");
  for (const c of Object.keys(CATEGORIES)) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    cat.appendChild(o);
  }

  const bar = document.createElement("div");
  bar.className = "uc-bar";

  const val = document.createElement("input");
  val.className = "uc-input";
  val.type = "number";
  val.value = "1";
  val.setAttribute("aria-label", "value to convert");

  const from = document.createElement("select");
  from.className = "uc-select";
  from.setAttribute("aria-label", "from unit");

  const swap = document.createElement("button");
  swap.type = "button";
  swap.className = "uc-swap";
  swap.title = "swap units";
  swap.textContent = "⇄";

  const to = document.createElement("select");
  to.className = "uc-select";
  to.setAttribute("aria-label", "to unit");

  const result = document.createElement("div");
  result.className = "uc-result";

  const foot = document.createElement("div");
  foot.className = "uc-foot";
  foot.textContent = footer;

  function fillUnits() {
    const units = CATEGORIES[cat.value];
    from.innerHTML = "";
    to.innerHTML = "";
    for (const u of units) {
      const o = document.createElement("option");
      o.value = u;
      o.textContent = u;
      from.appendChild(o);
      const t = document.createElement("option");
      t.value = u;
      t.textContent = u;
      to.appendChild(t);
    }
    to.selectedIndex = Math.min(1, units.length - 1);
  }

  function run() {
    const v = Number(val.value);
    if (val.value === "" || !Number.isFinite(v)) {
      result.textContent = "enter a number";
      return;
    }
    const r = convert(cat.value, from.value, to.value, v);
    result.textContent = fmt(v) + " " + from.value + " = " + fmt(r) + " " + to.value;
  }

  cat.addEventListener("change", () => {
    fillUnits();
    run();
  });
  val.addEventListener("input", run);
  from.addEventListener("change", run);
  to.addEventListener("change", run);
  swap.addEventListener("click", () => {
    const a = from.selectedIndex;
    from.selectedIndex = to.selectedIndex;
    to.selectedIndex = a;
    run();
  });

  fillUnits();
  bar.append(val, from, swap, to);
  root.append(head, cat, bar, result, foot);
  container.innerHTML = "";
  container.appendChild(root);
  run();
}

export function unmount(container) {
  container.innerHTML = "";
}
