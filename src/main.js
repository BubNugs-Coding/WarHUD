import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import "./style.css";

const app = document.querySelector("#app");
const API_OVERVIEW_URL = "/api/overview";
const API_DISPATCHES_URL = "/api/dispatches";
const API_MAJOR_ORDER_URL = "/api/major-order";
const IS_DEV = Boolean(import.meta?.env?.DEV);
/** Set `VITE_WARHUD_DEBUG=true` for glasses/bridge logs in production builds. */
const WARHUD_DEBUG = IS_DEV || import.meta.env?.VITE_WARHUD_DEBUG === "true";
/**
 * Glasses MVP: render overview only on-device (full UI stays in the browser DOM for debugging).
 * Set `VITE_WARHUD_GLASSES_FULL_UI=true` to mirror every view on glasses.
 */
const GLASSES_FULL_UI = import.meta.env?.VITE_WARHUD_GLASSES_FULL_UI === "true";
const STALE_AFTER_MS = 5 * 60 * 1000;
const REFRESH_INTERVAL_MS = 90 * 1000;
/** Monospace column widths — wide lines reduce vertical growth (glasses ~576px). */
const WRAP_COL_OVERVIEW = 76;
const WRAP_COL_DISPATCH = 72;
/** Hard cap so native text view does not scroll (swipes = navigation, not scroll). */
const MAX_VIEW_LINES = 20;
const MAX_TITLE_LINES_OVERVIEW = 4;
const MAX_TITLE_LINES_MO_DETAIL = 6;
const MAX_DISPATCH_ITEM_LINES = 11;
const GLASSES_TEXT_W = 576;
const GLASSES_TEXT_H = 288;
/** Glasses panel: slightly fewer lines than browser (native font is often taller than our CSS). */
const GLASSES_MAX_VIEW_LINES = 18;
const GLASSES_FAIL_DISABLE_AFTER = 2;
const WARHUD_VERBOSE_EVENTS = import.meta.env?.VITE_WARHUD_VERBOSE_EVENTS === "true";

/** First device test success criteria (checklist for humans): see log line `[WarHUD] first-test criteria`. */
function logFirstTestCriteria() {
  warHudLog("info", "first-test criteria", {
    loadInEvenHub: "App boots WebView, bridge resolves",
    overviewOnGlasses: "createStartUpPageContainer then textContainerUpgrade with overview text",
    oneInteraction: "EvenHub events move selection or confirm (see [input:evenhub] logs)",
    noSpam: "No repeated render throws; failures capped then browser fallback"
  });
}

function warHudLog(level, message, detail) {
  if (!WARHUD_DEBUG) return;
  const prefix = "[WarHUD]";
  if (detail !== undefined) {
    console[level === "error" ? "error" : "log"](prefix, message, detail);
  } else {
    console[level === "error" ? "error" : "log"](prefix, message);
  }
}

function readDisplayProfileOverride() {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? "");
    return q.get("warhudDisplay");
  } catch (_e) {
    return null;
  }
}

function resolveDisplayProfile(runtimeMode) {
  const override = readDisplayProfileOverride();
  if (override === "simulator" || override === "evenhub" || override === "browser") {
    return { label: override, source: "query" };
  }
  if (runtimeMode === "evenhub") {
    return { label: "evenhub", source: "bridge" };
  }
  return { label: "browser", source: "default" };
}

const state = {
  view: "overview",
  selectedOverviewIndex: 0,
  selectedPlanetIndex: 0,
  data: null,
  dispatches: [],
  dispatchMeta: { endpoint: null, latestId: null, latestPublished: null },
  liveContext: null,
  sourceLabel: "FRONTS",
  freshness: {
    app: null,
    planets: null,
    majorOrder: null,
    dispatches: null
  },
  health: {
    planetsOk: true,
    majorOrderOk: true,
    dispatchesOk: true,
    statusOk: true
  },
  runtimeMode: "browser",
  displayProfile: { label: "browser", source: "default" },
  bridge: null,
  glassesReady: false,
  glassesDisabled: false,
  lastGlassesRenderedText: "",
  glassesConsecutiveFailures: 0,
  /** `false` when `/api/overview` did not respond (usually backend not running). */
  warHudApiOk: null
};

function trendArrow(trend) {
  return trend === "down" ? "↓" : "↑";
}

function trimToMaxLines(text, maxLines = MAX_VIEW_LINES) {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  const head = lines.slice(0, Math.max(1, maxLines - 1));
  head.push("…");
  return head.join("\n");
}

function wrapWords(text, maxLen = WRAP_COL_OVERVIEW, maxLines = Number.POSITIVE_INFINITY) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ["No order"];

  const lines = [];
  let line = "";

  const canAddLine = () => lines.length < maxLines;

  for (const word of words) {
    let w = word;
    while (w.length > 0) {
      if (!canAddLine()) return lines;

      if (line.length === 0) {
        if (w.length <= maxLen) {
          line = w;
          w = "";
        } else {
          lines.push(w.slice(0, maxLen));
          w = w.slice(maxLen);
        }
      } else {
        const spaced = ` ${w}`;
        if (line.length + spaced.length <= maxLen) {
          line += spaced;
          w = "";
        } else {
          lines.push(line);
          line = "";
          if (!canAddLine()) return lines;
        }
      }
    }
  }
  if (line && canAddLine()) {
    lines.push(line);
  }
  return lines;
}

function planetUrgency(planet) {
  const isDef = Boolean(planet.label);
  const pct = Number(planet.percent) || 0;
  const hot = (planet.players ?? 0) >= 500;
  if (isDef) {
    if (pct < 35) return "CRITICAL";
    if (pct < 65 || hot) return "ALERT";
    return "DEFENSE";
  }
  if (planet.owner !== 1) {
    if (pct < 28) return "CRITICAL";
    if (pct < 52 || hot) return "ALERT";
    return "LOW";
  }
  return "STABLE";
}

function localTimeLabel() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `Updated ${hh}:${mm}`;
}

function formatTimeFromMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatMajorOrderTimeRemaining(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0m";
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function majorOrderTimeLeftLabel(mo) {
  if (mo?.expiresAtMs == null || !Number.isFinite(mo.expiresAtMs)) return null;
  const sec = Math.floor((mo.expiresAtMs - Date.now()) / 1000);
  if (sec <= 0) return "ended (await refresh)";
  return formatMajorOrderTimeRemaining(sec);
}

function isStale(ts) {
  return ts == null || Date.now() - ts > STALE_AFTER_MS;
}

function stripDispatchMarkup(text) {
  return String(text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function dispatchParagraphs(text) {
  return stripDispatchMarkup(text)
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function getPlanetNavCount() {
  return (state.data?.planets ?? []).length;
}

function getOverviewItemCount() {
  return getPlanetNavCount() + 2;
}

function dispatchNavIndex() {
  return getPlanetNavCount();
}

function majorOrderNavIndex() {
  return getPlanetNavCount() + 1;
}

function isDispatchRowSelected() {
  return state.selectedOverviewIndex === dispatchNavIndex();
}

function isMajorOrderDetailRowSelected() {
  return state.selectedOverviewIndex === majorOrderNavIndex();
}

function formatPlanetLineCompact(planet, index, selectedOverviewIndex) {
  const tag = (planet.urgency ?? planetUrgency(planet)).slice(0, 4);
  const name = String(planet.name ?? "?").slice(0, 14);
  const def = planet.label ? "DEF " : "";
  const marker = index === selectedOverviewIndex ? ">" : " ";
  return `${marker} ${name} ${def}${planet.percent}% | ${tag}`;
}

function buildOverviewText(data, selectedOverviewIndex, showBrowserHint) {
  const orderTitle = data?.majorOrder?.title ?? "Order unavailable";
  const orderProgress = data?.majorOrder?.progress ?? "?/?";
  const ctx = state.liveContext;
  const f = state.freshness;
  const h = state.health;

  const warn = [];
  if (state.warHudApiOk === false) {
    warn.push("API unreachable · start dev:all");
  } else {
    if (!h.statusOk && state.data) warn.push("status stale");
    if (!h.planetsOk) warn.push("planets fail");
    if (!h.majorOrderOk) warn.push("MO fail");
    if (!h.dispatchesOk) warn.push("dispatches fail");
    if (h.planetsOk && isStale(f.planets)) warn.push("planets old");
    if (h.majorOrderOk && isStale(f.majorOrder)) warn.push("MO old");
    if (h.dispatchesOk && isStale(f.dispatches)) warn.push("disp old");
  }

  const moLeft = majorOrderTimeLeftLabel(data?.majorOrder);
  const leftShort = moLeft ? moLeft : "—";
  const summaryOne = `SUM · fr ${ctx?.activeFronts ?? "?"} · def ${ctx?.defenseWorlds ?? "?"} · MO ${ctx?.moTargetWorlds ?? "?"}`;
  const orderBodyLines = wrapWords(orderTitle, WRAP_COL_OVERVIEW, MAX_TITLE_LINES_OVERVIEW).map((line) => `· ${line}`);

  const planets = (data?.planets ?? []).slice(0, 3).map((p) => ({ ...p, urgency: p.urgency ?? planetUrgency(p) }));
  const planetLines = planets.map((planet, index) => formatPlanetLineCompact(planet, index, selectedOverviewIndex));

  const dispatchIdx = dispatchNavIndex();
  const moIdx = majorOrderNavIndex();
  const dMark = selectedOverviewIndex === dispatchIdx ? ">" : " ";
  const mMark = selectedOverviewIndex === moIdx ? ">" : " ";
  const navRow = `${dMark} Dispatches   ${mMark} MO detail`;

  const lines = [
    `WAR · ${formatTimeFromMs(f.app)}`,
    ...(warn.length ? wrapWords(`! ${warn.join(" · ")}`, WRAP_COL_OVERVIEW, 2).map((w) => `· ${w}`) : []),
    `· ${summaryOne}`,
    `· MO ${orderProgress} · left ${leftShort}`,
    ...orderBodyLines,
    state.sourceLabel,
    ...planetLines,
    navRow,
    localTimeLabel()
  ];
  if (showBrowserHint) {
    lines.push("[↑↓ Enter] [D]isp");
    lines.push(`Mode: ${state.runtimeMode === "evenhub" ? "Even Hub" : "Browser"}`);
    if (IS_DEV) {
      lines.push(`Dev: ${state.displayProfile.label} gl:${GLASSES_FULL_UI ? "full" : "ov"}`);
    }
  }
  return trimToMaxLines(lines.join("\n"));
}

function buildDetailText(data, selectedPlanetIndex, showBrowserHint) {
  const planet = (data?.planets ?? [])[selectedPlanetIndex];
  if (!planet) {
    return trimToMaxLines(["PLANET", "None selected", ...(showBrowserHint ? ["[Esc]"] : [])].join("\n"));
  }

  const tag = planet.urgency ?? planetUrgency(planet);
  const lines = [
    `PLANET · ${planet.name ?? "Unknown"}`,
    `· ${formatTimeFromMs(state.freshness.planets)} · ${tag} · ${planet.front ?? "—"}`,
    `· ${planet.label ? `${planet.label} ` : ""}${planet.percent}% ${trendArrow(planet.trend)} · ply ${planet.players ?? "?"}`
  ];

  if (!state.health.planetsOk) {
    lines.push("· ! stale planet data");
  } else if (isStale(state.freshness.planets)) {
    lines.push("· ! data aged");
  }

  const meta = [planet.sector ? `sec ${planet.sector}` : "", planet.biome ? `bio ${planet.biome}` : ""]
    .filter(Boolean)
    .join(" · ");
  if (meta) {
    lines.push(`· ${meta}`);
  }
  if (showBrowserHint) {
    lines.push("[Esc]");
    lines.push(`Mode: ${state.runtimeMode === "evenhub" ? "Even Hub" : "Browser"}`);
  }
  return trimToMaxLines(lines.join("\n"));
}

function buildMajorOrderDetailText(data, showBrowserHint) {
  const orderTitle = data?.majorOrder?.title ?? "Order unavailable";
  const orderProgress = data?.majorOrder?.progress ?? "?/?";
  const bodyLines = wrapWords(orderTitle, WRAP_COL_OVERVIEW, MAX_TITLE_LINES_MO_DETAIL).map((line) => `· ${line}`);
  const moLeft = majorOrderTimeLeftLabel(data?.majorOrder);
  const lines = [
    `MO DETAIL · ${formatTimeFromMs(state.freshness.majorOrder)}`,
    `· prog ${orderProgress} · left ${moLeft ?? "—"}`,
    ...bodyLines
  ];
  if (!state.health.majorOrderOk) {
    lines.splice(1, 0, "· ! MO feed fail (cached)");
  } else if (isStale(state.freshness.majorOrder)) {
    lines.splice(1, 0, "· ! MO may be stale");
  }
  if (showBrowserHint) {
    lines.push("[Esc]");
    lines.push(`Mode: ${state.runtimeMode === "evenhub" ? "Even Hub" : "Browser"}`);
  }
  return trimToMaxLines(lines.join("\n"));
}

function buildDispatchesText(dispatches, showBrowserHint) {
  const lines = [`DISPATCH · ${formatTimeFromMs(state.freshness.dispatches)}`];
  const items = dispatches ?? [];

  if (!state.health.dispatchesOk) {
    lines.push("· last feed only");
  } else if (isStale(state.freshness.dispatches)) {
    lines.push("· may be stale");
  }

  if (items.length === 0) {
    lines.push("No items.");
  } else {
    const item = items[0];
    const paragraphs = dispatchParagraphs(item.message);
    let budget = MAX_DISPATCH_ITEM_LINES;
    let firstRow = true;
    outer: for (const para of paragraphs) {
      if (budget <= 0) break;
      const wrapped = wrapWords(para, WRAP_COL_DISPATCH, budget);
      for (const row of wrapped) {
        if (budget <= 0) break outer;
        lines.push(firstRow ? `- ${row}` : `  ${row}`);
        firstRow = false;
        budget -= 1;
      }
    }
    if (items.length > 1) {
      lines.push(`· +${items.length - 1} more in feed`);
    }
  }

  lines.push(localTimeLabel());
  if (showBrowserHint) {
    const latestLine = state.dispatchMeta?.latestId
      ? `ID ${state.dispatchMeta.latestId}`
      : state.dispatchMeta?.latestPublished
        ? `Tick ${state.dispatchMeta.latestPublished}`
        : "";
    if (latestLine) {
      lines.push(latestLine);
    }
    lines.push("[Esc]");
    lines.push(`Mode: ${state.runtimeMode === "evenhub" ? "Even Hub" : "Browser"}`);
  }
  return trimToMaxLines(lines.join("\n"));
}

function currentScreenText() {
  if (!state.data) {
    return "WAR STATUS\nLoading...";
  }
  const showBrowserHint = state.runtimeMode === "browser";
  if (state.view === "detail") {
    return buildDetailText(state.data, state.selectedPlanetIndex, showBrowserHint);
  }
  if (state.view === "majorOrder") {
    return buildMajorOrderDetailText(state.data, showBrowserHint);
  }
  if (state.view === "dispatches") {
    return buildDispatchesText(state.dispatches, showBrowserHint);
  }
  return buildOverviewText(state.data, state.selectedOverviewIndex, showBrowserHint);
}

/** Text pushed to the glasses bridge (may differ from DOM in overview-only MVP mode). */
function currentGlassesScreenText() {
  if (!state.data) {
    return "WAR STATUS\nLoading...";
  }
  if (state.runtimeMode !== "evenhub") {
    return currentScreenText();
  }
  if (GLASSES_FULL_UI) {
    return trimToMaxLines(currentScreenText(), GLASSES_MAX_VIEW_LINES);
  }
  return trimToMaxLines(buildOverviewText(state.data, state.selectedOverviewIndex, false), GLASSES_MAX_VIEW_LINES);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function safeFetchJson(url) {
  try {
    return { ok: true, data: await fetchJson(url) };
  } catch (_error) {
    return { ok: false, data: null };
  }
}

// Pull normalized sections from the local WarHUD backend and merge into UI state.
async function refreshFromApi() {
  const now = Date.now();
  state.freshness.app = now;
  const [overviewRes, dispatchesRes, majorOrderRes] = await Promise.all([
    safeFetchJson(API_OVERVIEW_URL),
    safeFetchJson(API_DISPATCHES_URL),
    safeFetchJson(API_MAJOR_ORDER_URL)
  ]);

  if (overviewRes.ok) {
    const overview = overviewRes.data ?? {};
    const overviewData = overview.data ?? {};
    state.data = state.data ?? { planets: [] };
    state.data.planets = Array.isArray(overviewData.planets) ? overviewData.planets : state.data.planets ?? [];
    state.data.majorOrder = overviewData.majorOrder ?? state.data.majorOrder;
    state.liveContext = overviewData.liveContext ?? state.liveContext;
    state.sourceLabel = overviewData.sourceLabel ?? "FRONTS";
    state.freshness = {
      ...state.freshness,
      ...(overview.freshness ?? {})
    };
    state.health = {
      ...state.health,
      ...(overview.health ?? {})
    };
  } else {
    state.health.statusOk = false;
    state.health.planetsOk = false;
  }

  if (dispatchesRes.ok) {
    const payload = dispatchesRes.data ?? {};
    state.dispatches = Array.isArray(payload.data) ? payload.data : state.dispatches;
    state.dispatchMeta = payload.dispatchMeta ?? state.dispatchMeta;
    if (payload.freshness?.dispatches != null) {
      state.freshness.dispatches = payload.freshness.dispatches;
    }
    if (typeof payload.status?.dispatchesOk === "boolean") {
      state.health.dispatchesOk = payload.status.dispatchesOk;
    }
  }

  if (majorOrderRes.ok) {
    const payload = majorOrderRes.data ?? {};
    state.data = state.data ?? { planets: [] };
    state.data.majorOrder = payload.data ?? state.data.majorOrder;
    if (payload.freshness?.majorOrder != null) {
      state.freshness.majorOrder = payload.freshness.majorOrder;
    }
    if (typeof payload.status?.majorOrderOk === "boolean") {
      state.health.majorOrderOk = payload.status.majorOrderOk;
    }
  }
  if (!state.data) {
    state.data = {
      planets: [],
      majorOrder: {
        title: "WarHUD backend unavailable",
        progress: "?/?",
        targetWorlds: 0,
        expiresAtMs: null
      }
    };
    state.liveContext = {
      activeFronts: "?",
      defenseWorlds: "?",
      moTargetWorlds: 0
    };
    state.dispatches = [];
    state.dispatchMeta = { endpoint: null, latestId: null, latestPublished: null };
    state.health = {
      statusOk: false,
      planetsOk: false,
      majorOrderOk: false,
      dispatchesOk: false
    };
  }

  state.warHudApiOk = overviewRes.ok;
}

// Keep one text container alive on glasses; update content in-place on each render tick.
async function renderOnGlasses(bridge, content) {
  if (!state.glassesReady) {
    warHudLog("info", "glasses: creating startup container", {
      containerID: 1,
      bytes: content.length
    });
    const textContainer = {
      xPosition: 0,
      yPosition: 0,
      width: GLASSES_TEXT_W,
      height: GLASSES_TEXT_H,
      paddingLength: 2,
      containerID: 1,
      containerName: "warhud-main",
      content,
      isEventCapture: 1
    };

    const created = await bridge.createStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [textContainer]
    });

    if (created !== 0) {
      throw new Error(`createStartUpPageContainer failed: ${String(created)}`);
    }
    state.glassesReady = true;
    warHudLog("info", "glasses: container created", { resultCode: created });
    return;
  }

  warHudLog("info", "glasses: textContainerUpgrade", {
    containerID: 1,
    contentLength: content.length
  });
  await bridge.textContainerUpgrade({
    containerID: 1,
    containerName: "warhud-main",
    contentOffset: 0,
    contentLength: content.length,
    content
  });
}

async function detectRuntimeMode() {
  const hostBridge = globalThis?.flutter_inappwebview;
  if (!hostBridge || typeof hostBridge.callHandler !== "function") {
    warHudLog("info", "bridge: no flutter_inappwebview host — browser fallback");
    return { runtimeMode: "browser", bridge: null };
  }

  warHudLog("info", "bridge: host present, waiting for EvenAppBridge");
  try {
    const bridge = await waitForEvenAppBridge();
    if (
      !bridge ||
      typeof bridge.createStartUpPageContainer !== "function" ||
      typeof bridge.textContainerUpgrade !== "function"
    ) {
      warHudLog("info", "bridge: resolved but missing container APIs — browser fallback", {
        hasBridge: Boolean(bridge)
      });
      return { runtimeMode: "browser", bridge: null };
    }
    warHudLog("info", "bridge: Even Hub mode", {
      hasOnEvenHubEvent: typeof bridge.onEvenHubEvent === "function"
    });
    return { runtimeMode: "evenhub", bridge };
  } catch (error) {
    warHudLog("error", "bridge: waitForEvenAppBridge failed — browser fallback", error);
    return { runtimeMode: "browser", bridge: null };
  }
}

// DOM and glasses have separate render caches so one surface can update without forcing the other.
async function syncRender() {
  const browserText = currentScreenText();
  app.textContent = browserText;

  if (state.runtimeMode !== "evenhub" || !state.bridge || state.glassesDisabled) {
    return;
  }

  const glassesText = currentGlassesScreenText();
  if (glassesText === state.lastGlassesRenderedText) {
    return;
  }
  state.lastGlassesRenderedText = glassesText;

  try {
    await renderOnGlasses(state.bridge, glassesText);
    state.glassesConsecutiveFailures = 0;
  } catch (renderError) {
    state.glassesConsecutiveFailures += 1;
    warHudLog("error", `glasses: render failed (${state.glassesConsecutiveFailures}/${GLASSES_FAIL_DISABLE_AFTER})`, {
      message: String(renderError?.message ?? renderError)
    });
    if (state.glassesConsecutiveFailures >= GLASSES_FAIL_DISABLE_AFTER) {
      state.glassesDisabled = true;
      state.glassesReady = false;
      state.bridge = null;
      state.runtimeMode = "browser";
      state.lastGlassesRenderedText = "";
      warHudLog("error", "glasses: disabled after repeated failures — browser fallback only");
      app.textContent = currentScreenText();
    }
  }
}

/** Push latest text to DOM + glasses again (e.g. after a code change the simulator did not HMR). */
async function forceWarHudRerender(reason = "manual") {
  warHudLog("info", "force rerender", { reason });
  state.lastGlassesRenderedText = "";
  await refreshFromApi();
  await syncRender();
}

async function moveSelectionUp() {
  const count = getOverviewItemCount();
  if (!count || state.view !== "overview") return;
  state.selectedOverviewIndex = (state.selectedOverviewIndex - 1 + count) % count;
  await syncRender();
}

async function moveSelectionDown() {
  const count = getOverviewItemCount();
  if (!count || state.view !== "overview") return;
  state.selectedOverviewIndex = (state.selectedOverviewIndex + 1) % count;
  await syncRender();
}

async function openSelectedPlanet() {
  if (!getOverviewItemCount() || state.view !== "overview") return;
  if (isDispatchRowSelected()) {
    await openDispatches();
    return;
  }
  if (isMajorOrderDetailRowSelected()) {
    await openMajorOrderDetail();
    return;
  }
  state.selectedPlanetIndex = state.selectedOverviewIndex;
  state.view = "detail";
  await syncRender();
}

async function openMajorOrderDetail() {
  if (state.view !== "overview") return;
  state.view = "majorOrder";
  await syncRender();
}

async function openDispatches() {
  if (state.view !== "overview") return;
  state.view = "dispatches";
  await syncRender();
}

async function goBack() {
  if (state.view !== "detail" && state.view !== "dispatches" && state.view !== "majorOrder") return;
  state.view = "overview";
  await syncRender();
}

function debugInput(source, eventName, actionName) {
  if (!WARHUD_DEBUG) return;
  console.log(`[input:${source}] ${eventName} -> ${actionName}`);
}

function setupBrowserKeyboardInput() {
  window.addEventListener("keydown", async (event) => {
    if (!state.data || state.runtimeMode !== "browser") return;

    if (event.key === "ArrowUp") {
      event.preventDefault();
      debugInput("keyboard", "ArrowUp", "moveSelectionUp");
      await moveSelectionUp();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      debugInput("keyboard", "ArrowDown", "moveSelectionDown");
      await moveSelectionDown();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      debugInput("keyboard", "Enter", "openSelectedPlanet");
      await openSelectedPlanet();
      return;
    }

    if (event.key.toLowerCase() === "d") {
      event.preventDefault();
      debugInput("keyboard", "d", "openDispatches");
      await openDispatches();
      return;
    }

    if (event.key === "Escape" || event.key === "Backspace") {
      event.preventDefault();
      debugInput("keyboard", event.key, "goBack");
      await goBack();
    }
  });
}

function normalizeEventToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
}

function collectEvenHubTokens(event) {
  const tokens = [];
  const listEvent = event?.listEvent ?? {};
  const textEvent = event?.textEvent ?? {};
  const sysEvent = event?.sysEvent ?? {};
  const raw = event?.jsonData ?? {};

  tokens.push(
    listEvent?.currentSelectItemName,
    listEvent?.eventType,
    textEvent?.eventType,
    sysEvent?.eventType,
    sysEvent?.eventSource,
    raw?.eventType,
    raw?.eventSource,
    raw?.action,
    raw?.gesture,
    raw?.key,
    raw?.name,
    raw?.type
  );

  return tokens.map(normalizeEventToken).filter(Boolean);
}

// Normalize host event variants into the app's central navigation actions.
async function handleEvenHubInputEvent(event) {
  const tokens = collectEvenHubTokens(event);
  if (tokens.length === 0) {
    if (WARHUD_VERBOSE_EVENTS) {
      warHudLog("info", "evenhub: event (no tokens)", { rawKeys: event ? Object.keys(event) : [] });
    }
    return;
  }

  const has = (matches) => matches.some((match) => tokens.some((token) => token.includes(match)));
  const summary = tokens.slice(0, 3).join(",");
  warHudLog("info", `evenhub: event tokens=${summary}`);

  // Prioritize back over selection when an event is ambiguous.
  if (has(["back", "close", "exit", "cancel"])) {
    debugInput("evenhub", summary, "goBack");
    await goBack();
    return;
  }
  if (has(["down", "next", "forward", "scrolldown", "swipedown", "right"])) {
    debugInput("evenhub", summary, "moveSelectionDown");
    await moveSelectionDown();
    return;
  }
  if (has(["up", "prev", "previous", "backward", "scrollup", "swipeup", "left"])) {
    debugInput("evenhub", summary, "moveSelectionUp");
    await moveSelectionUp();
    return;
  }
  if (has(["tap", "select", "confirm", "enter", "ok", "click"])) {
    debugInput("evenhub", summary, "openSelectedPlanet");
    await openSelectedPlanet();
    return;
  }
  if (has(["secondary", "menu", "info", "more", "dispatch"])) {
    debugInput("evenhub", summary, "openDispatches");
    await openDispatches();
  }
}

function setupEvenHubInput(bridge) {
  if (!bridge || typeof bridge.onEvenHubEvent !== "function") {
    return;
  }

  bridge.onEvenHubEvent((event) => {
    void handleEvenHubInputEvent(event);
  });
}

async function boot() {
  app.textContent = "Loading war data...";
  state.sourceLabel = "FRONTS";
  state.glassesReady = false;
  state.glassesDisabled = false;
  state.lastGlassesRenderedText = "";
  state.glassesConsecutiveFailures = 0;
  await refreshFromApi();

  const runtime = await detectRuntimeMode();
  state.runtimeMode = runtime.runtimeMode;
  state.bridge = runtime.bridge;
  state.displayProfile = resolveDisplayProfile(state.runtimeMode);

  warHudLog("info", "display context", {
    runtimeMode: state.runtimeMode,
    displayProfile: state.displayProfile,
    glassesPipeline: GLASSES_FULL_UI ? "full UI on glasses" : "overview-only on glasses (MVP)",
    debug: WARHUD_DEBUG
  });
  logFirstTestCriteria();

  setupBrowserKeyboardInput();
  if (state.runtimeMode === "evenhub" && state.bridge) {
    setupEvenHubInput(state.bridge);
  }

  setInterval(() => {
    void refreshFromApi().then(() => syncRender());
  }, REFRESH_INTERVAL_MS);

  await syncRender();
}

if (IS_DEV) {
  globalThis.__WARHUD_SYNC__ = () => forceWarHudRerender("__WARHUD_SYNC__");
  globalThis.__WARHUD_RELOAD__ = () => globalThis.location.reload();
  warHudLog("info", "dev: use __WARHUD_SYNC__() or __WARHUD_RELOAD__() if simulator view is stale");
}

if (import.meta.hot) {
  // Even simulator WebView often misses incremental HMR; full reload pulls new JS/CSS reliably.
  import.meta.hot.accept(() => {
    globalThis.location.reload();
  });
}

boot().catch((error) => {
  app.textContent = `WAR STATUS\nData unavailable`;
  console.error(error);
});
