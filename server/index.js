import express from "express";

const PORT = Number(process.env.PORT ?? 8787);
const CACHE_TTL_MS = Number(process.env.WARHUD_CACHE_TTL_MS ?? 45000);
const STALE_AFTER_MS = Number(process.env.WARHUD_STALE_AFTER_MS ?? 5 * 60 * 1000);

const LIVE_STATUS_URL = "https://helldiverstrainingmanual.com/api/v1/war/status";
const LIVE_ORDERS_URL = "https://helldiverstrainingmanual.com/api/v1/war/major-orders";
const LIVE_PLANETS_URL = "https://helldiverstrainingmanual.com/api/v1/planets";
const LIVE_NEWS_URL_CANDIDATES = [
  "https://helldiverstrainingmanual.com/api/v1/war/news",
  "https://helldiverstrainingmanual.com/api/v1/news",
  "https://helldiverstrainingmanual.com/api/v1/dispatches"
];

const OWNER_LABEL = {
  1: "Super Earth",
  2: "Terminid",
  3: "Automaton",
  4: "Illuminate"
};

const app = express();

// In-memory cache keeps last good payloads so API callers still get usable data during upstream outages.
const cache = {
  inFlight: null,
  cachedAt: null,
  sourceUpdatedAt: null,
  data: {
    planets: [],
    majorOrder: { title: "Major order feed offline", progress: "?/?", targetWorlds: 0, expiresAtMs: null },
    dispatches: [],
    dispatchMeta: { endpoint: null, latestId: null, latestPublished: null },
    liveContext: null
  },
  freshness: {
    app: null,
    planets: null,
    majorOrder: null,
    dispatches: null
  },
  health: {
    statusOk: false,
    planetsOk: false,
    majorOrderOk: false,
    dispatchesOk: false
  },
  sectionStatus: {
    status: { ok: false, lastFetchAt: null, lastSuccessAt: null, lastError: null },
    majorOrder: { ok: false, lastFetchAt: null, lastSuccessAt: null, lastError: null },
    planetsMeta: { ok: false, lastFetchAt: null, lastSuccessAt: null, lastError: null },
    dispatches: { ok: false, lastFetchAt: null, lastSuccessAt: null, lastError: null }
  }
};

function stripDispatchMarkup(text) {
  return String(text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
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

function parseLiveMajorOrder(rawOrders, fetchedAtMs = Date.now()) {
  const first = Array.isArray(rawOrders) ? rawOrders[0] : rawOrders?.[0];
  if (!first) {
    return { title: "No active order", progress: "0/0", targetWorlds: 0, expiresAtMs: null };
  }

  const setting = first?.setting ?? {};
  const title = setting.overrideBrief || setting.taskDescription || first.title || "Major Order";
  const tasks = Array.isArray(setting.tasks) ? setting.tasks : [];
  const progress = Array.isArray(first.progress) ? first.progress : [];
  const done = Number.isFinite(progress[0]) ? progress[0] : 0;
  const total = tasks.length || 0;
  const moTargets = new Set(
    tasks
      .map((task) => (Array.isArray(task?.values) ? task.values[2] : null))
      .filter((value) => Number.isInteger(value))
  );
  const expiresIn = first.expiresIn;
  let expiresAtMs = null;
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    expiresAtMs = fetchedAtMs + expiresIn * 1000;
  }
  return {
    title: String(title).replace(/\s+/g, " ").trim(),
    progress: `${done}/${total || "?"}`,
    targetWorlds: moTargets.size,
    expiresAtMs
  };
}

function parseDispatchesFromWarStatus(rawStatus) {
  const events = Array.isArray(rawStatus?.globalEvents) ? rawStatus.globalEvents : [];
  return events
    .filter((event) => typeof event?.message === "string" && event.message.trim().length > 0)
    .map((event) => ({
      id: event.id32 ?? event.eventId ?? null,
      published: event.expireTime ?? rawStatus?.time ?? null,
      message: stripDispatchMarkup(event.message),
      source: "war/status"
    }))
    .sort((a, b) => (b?.published ?? 0) - (a?.published ?? 0) || (b?.id ?? 0) - (a?.id ?? 0));
}

function parseLiveDispatches(rawNews) {
  const list = Array.isArray(rawNews) ? rawNews : [];
  return list
    .filter((item) => typeof item?.message === "string" && item.message.trim().length > 0)
    .sort((a, b) => (b?.published ?? 0) - (a?.published ?? 0) || (b?.id ?? 0) - (a?.id ?? 0))
    .map((item) => ({
      id: item.id ?? null,
      published: item.published ?? null,
      message: stripDispatchMarkup(item.message),
      source: "news"
    }));
}

function indexNameMap(rawPlanets) {
  const map = new Map();
  for (const [index, info] of Object.entries(rawPlanets ?? {})) {
    if (info?.name) {
      map.set(Number(index), info.name);
    }
  }
  return map;
}

function percentFromStatus(planetStatus, eventMap) {
  const event = eventMap.get(planetStatus.index);
  if (event?.maxHealth && Number.isFinite(event.health)) {
    return Math.max(0, Math.min(100, Math.round((event.health / event.maxHealth) * 100)));
  }
  return planetStatus.owner === 1 ? 100 : 0;
}

function parseLivePlanets(rawStatus, rawOrders, rawPlanets) {
  const allPlanets = Array.isArray(rawStatus?.planetStatus) ? rawStatus.planetStatus : [];
  const nameByIndex = indexNameMap(rawPlanets);
  const events = Array.isArray(rawStatus?.planetEvents) ? rawStatus.planetEvents : [];
  const eventMap = new Map(events.map((event) => [event.planetIndex, event]));

  const majorOrderTasks = Array.isArray(rawOrders?.[0]?.setting?.tasks) ? rawOrders[0].setting.tasks : [];
  const majorOrderIndexes = majorOrderTasks
    .map((task) => (Array.isArray(task?.values) ? task.values[2] : null))
    .filter((value) => Number.isInteger(value));

  const campaignSet = new Set(
    (Array.isArray(rawStatus?.campaigns) ? rawStatus.campaigns : []).map((campaign) => campaign.planetIndex)
  );

  const ranked = allPlanets
    .filter((planet) => Number.isInteger(planet?.index))
    .sort((a, b) => (b.players ?? 0) - (a.players ?? 0));

  const picked = [];
  for (const index of majorOrderIndexes) {
    const hit = allPlanets.find((planet) => planet.index === index);
    if (hit) picked.push(hit);
  }
  for (const planet of ranked) {
    if (picked.length >= 3) break;
    if (!picked.some((item) => item.index === planet.index)) picked.push(planet);
  }

  return picked.slice(0, 3).map((planet) => {
    const planetMeta = rawPlanets?.[String(planet.index)] ?? {};
    const name = nameByIndex.get(planet.index) || `P-${planet.index ?? "?"}`;
    const percent = percentFromStatus(planet, eventMap);
    const trend = planet.owner === 1 ? "up" : "down";
    const label = campaignSet.has(planet.index) ? "DEF" : "";
    const row = {
      name,
      percent,
      trend,
      label,
      players: planet.players ?? null,
      owner: planet.owner ?? null,
      front: OWNER_LABEL[planet.owner] ?? "Unknown",
      sector: planetMeta?.sector ?? "",
      biome: planetMeta?.biome?.slug ?? "",
      index: planet.index
    };
    return { ...row, urgency: planetUrgency(row) };
  });
}

function extractLiveContext(rawStatus, majorOrderRef) {
  if (!rawStatus) return null;
  const campaigns = Array.isArray(rawStatus.campaigns) ? rawStatus.campaigns : [];
  const activeFronts = campaigns.length;
  let defenseWorlds = campaigns.filter((c) => c.type === 1).length;
  if (defenseWorlds === 0) {
    defenseWorlds = Array.isArray(rawStatus.planetEvents) ? rawStatus.planetEvents.length : 0;
  }
  const mo = majorOrderRef ?? { targetWorlds: 0 };
  return {
    activeFronts,
    defenseWorlds,
    moTargetWorlds: mo.targetWorlds ?? 0
  };
}

function isStale(ts) {
  return ts == null || Date.now() - ts > STALE_AFTER_MS;
}

function updateSection(sectionName, ok, now, errorMessage = null) {
  const entry = cache.sectionStatus[sectionName];
  entry.ok = ok;
  entry.lastFetchAt = now;
  entry.lastError = errorMessage;
  if (ok) {
    entry.lastSuccessAt = now;
    cache.sourceUpdatedAt = now;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function fetchDispatchFeed() {
  for (const endpoint of LIVE_NEWS_URL_CANDIDATES) {
    try {
      const response = await fetchJson(endpoint);
      return { endpoint, response };
    } catch (_error) {
      // Try next candidate.
    }
  }
  throw new Error("No dispatch endpoint available");
}

// Refresh all upstream sources, then update cached sections independently (partial failures are tolerated).
async function refreshCache() {
  const now = Date.now();
  const [statusResult, ordersResult, planetsResult] = await Promise.allSettled([
    fetchJson(LIVE_STATUS_URL),
    fetchJson(LIVE_ORDERS_URL),
    fetchJson(LIVE_PLANETS_URL)
  ]);

  const statusOk = statusResult.status === "fulfilled";
  const ordersOk = ordersResult.status === "fulfilled";
  const planetsMetaOk = planetsResult.status === "fulfilled";

  updateSection("status", statusOk, now, statusOk ? null : String(statusResult.reason?.message ?? "status failed"));
  updateSection(
    "majorOrder",
    ordersOk,
    now,
    ordersOk ? null : String(ordersResult.reason?.message ?? "major order failed")
  );
  updateSection(
    "planetsMeta",
    planetsMetaOk,
    now,
    planetsMetaOk ? null : String(planetsResult.reason?.message ?? "planets meta failed")
  );

  const statusData = statusOk ? statusResult.value : null;
  const ordersData = ordersOk ? ordersResult.value : null;
  const planetsMetaData = planetsMetaOk ? planetsResult.value : null;

  if (ordersOk) {
    cache.data.majorOrder = parseLiveMajorOrder(ordersData, now);
    cache.freshness.majorOrder = now;
  }

  if (statusOk && ordersOk && planetsMetaOk) {
    const parsedPlanets = parseLivePlanets(statusData, ordersData, planetsMetaData);
    if (parsedPlanets.length > 0) {
      cache.data.planets = parsedPlanets;
      cache.freshness.planets = now;
    }
  }

  if (statusOk) {
    const fromStatus = parseDispatchesFromWarStatus(statusData);
    let dispatches = fromStatus;
    let dispatchMetaEndpoint = "war/status.globalEvents";
    if (dispatches.length === 0) {
      try {
        const dispatchFeed = await fetchDispatchFeed();
        dispatches = parseLiveDispatches(dispatchFeed.response);
        dispatchMetaEndpoint = dispatchFeed.endpoint;
        updateSection("dispatches", true, now, null);
      } catch (error) {
        updateSection("dispatches", false, now, String(error?.message ?? "dispatches failed"));
      }
    } else {
      updateSection("dispatches", true, now, null);
    }

    if (dispatches.length > 0 || cache.data.dispatches.length === 0) {
      cache.data.dispatches = dispatches;
    }
    const latest = cache.data.dispatches[0] ?? null;
    cache.data.dispatchMeta = {
      endpoint: dispatchMetaEndpoint,
      latestId: latest?.id ?? null,
      latestPublished: latest?.published ?? null
    };
    cache.freshness.dispatches = now;
    cache.data.liveContext = extractLiveContext(statusData, cache.data.majorOrder);
  } else {
    updateSection("dispatches", false, now, "status unavailable for dispatch parsing");
  }

  cache.health = {
    statusOk,
    planetsOk: statusOk && ordersOk && planetsMetaOk,
    majorOrderOk: ordersOk,
    dispatchesOk: cache.sectionStatus.dispatches.ok
  };
  cache.freshness.app = now;
  cache.cachedAt = now;
}

// Collapse concurrent requests onto one refresh and enforce TTL between refresh cycles.
async function ensureFreshCache() {
  if (cache.cachedAt && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return;
  }
  if (!cache.inFlight) {
    cache.inFlight = refreshCache().finally(() => {
      cache.inFlight = null;
    });
  }
  await cache.inFlight;
}

function endpointMeta(sectionKey) {
  const ts = cache.freshness[sectionKey] ?? cache.cachedAt;
  return {
    stale: isStale(ts),
    sourceUpdatedAt: cache.sourceUpdatedAt,
    cachedAt: cache.cachedAt
  };
}

app.get("/api/overview", async (_req, res) => {
  await ensureFreshCache();
  res.json({
    data: {
      planets: cache.data.planets,
      majorOrder: cache.data.majorOrder,
      liveContext: cache.data.liveContext,
      sourceLabel: "FRONTS"
    },
    freshness: cache.freshness,
    health: cache.health,
    meta: endpointMeta("app")
  });
});

app.get("/api/planet/:id", async (req, res) => {
  await ensureFreshCache();
  const planetId = Number(req.params.id);
  const planet = cache.data.planets.find((item) => item.index === planetId);
  if (!planet) {
    res.status(404).json({
      error: "Planet not found in active WarHUD set",
      meta: endpointMeta("planets")
    });
    return;
  }
  res.json({
    data: planet,
    freshness: { planets: cache.freshness.planets },
    status: { planetsOk: cache.health.planetsOk },
    meta: endpointMeta("planets")
  });
});

app.get("/api/dispatches", async (_req, res) => {
  await ensureFreshCache();
  res.json({
    data: cache.data.dispatches,
    dispatchMeta: cache.data.dispatchMeta,
    freshness: { dispatches: cache.freshness.dispatches },
    status: { dispatchesOk: cache.health.dispatchesOk },
    meta: endpointMeta("dispatches")
  });
});

app.get("/api/major-order", async (_req, res) => {
  await ensureFreshCache();
  res.json({
    data: cache.data.majorOrder,
    freshness: { majorOrder: cache.freshness.majorOrder },
    status: { majorOrderOk: cache.health.majorOrderOk },
    meta: endpointMeta("majorOrder")
  });
});

app.listen(PORT, () => {
  console.log(`WarHUD backend listening on http://localhost:${PORT}`);
});
