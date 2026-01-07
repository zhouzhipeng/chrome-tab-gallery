const PREVIEW_KEY = "tabPreviews";
const LAST_ACTIVE_KEY = "tabLastActive";
const AUTO_CAPTURE_COOLDOWN_MS = 30000;
const AUTO_CAPTURE_INTERVAL_MS = 60000;
const STALE_PREVIEW_AGE_MS = 3 * 60 * 1000;
const BODY_SYNC_DEBOUNCE_MS = 250;
const BODY_SYNC_COOLDOWN_MS = 1000;
const BODY_SYNC_BATCH_LIMIT = 20;

const grid = document.getElementById("tab-grid");
const searchInput = document.getElementById("search");

let windowsState = [];
let previewsState = {};
let lastActiveState = {};
let refreshTimer = null;
let captureInFlight = false;
let lastCaptureRequestAt = 0;
let autoCaptureTimer = null;
let bodySyncTimer = null;
let bodySyncInFlight = false;
let lastBodySyncAt = 0;

init();

function init() {
  searchInput.addEventListener("input", () => {
    render();
    scheduleBodyTextSync();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    if (message.type === "captureStart") {
      captureInFlight = true;
    }
    if (message.type === "captureDone") {
      captureInFlight = false;
      refresh();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[PREVIEW_KEY]) {
      previewsState = changes[PREVIEW_KEY].newValue || {};
      render();
    }
    if (changes[LAST_ACTIVE_KEY]) {
      lastActiveState = changes[LAST_ACTIVE_KEY].newValue || {};
      render();
    }
  });

  registerLiveUpdates();
  refresh();
  startAutoCapture();
}

function registerLiveUpdates() {
  const schedule = () => scheduleRefresh();
  chrome.tabs.onCreated.addListener(schedule);
  chrome.tabs.onRemoved.addListener(schedule);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.title || changeInfo.url || changeInfo.status === "complete") {
      scheduleRefresh();
    }
  });
  chrome.tabs.onActivated.addListener(schedule);
  chrome.windows.onCreated.addListener(schedule);
  chrome.windows.onRemoved.addListener(schedule);
  chrome.windows.onFocusChanged.addListener(schedule);
}

async function refresh() {
  const [windows, previews, lastActive] = await Promise.all([
    getWindows(),
    getPreviews(),
    getLastActive(),
  ]);
  windowsState = windows;
  previewsState = previews;
  lastActiveState = lastActive;
  await reconcileLastActive(windowsState, lastActiveState);
  render();
  await maybeRequestActiveCapture();
  scheduleBodyTextSync();
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

function render() {
  grid.innerHTML = "";
  const query = searchInput.value.trim().toLowerCase();
  let cardIndex = 0;
  const rawTabs = windowsState.flatMap((win) => win.tabs || []);
  let tabs = rawTabs;
  if (query) {
    const scored = rawTabs
      .map((tab) => {
        const match = getSearchMatch(tab, query);
        if (!match) return null;
        return { tab, rank: match.rank };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return compareTabsByLastActive(a.tab, b.tab);
      });
    tabs = scored.map((entry) => entry.tab);
  } else {
    tabs = rawTabs.sort((a, b) => compareTabsByLastActive(a, b));
  }

  tabs.forEach((tab) => {
    cardIndex += 1;
    const card = buildTabCard(tab, cardIndex);
    grid.appendChild(card);
  });

  if (tabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = query ? "No tabs match your search." : "No tabs found.";
    grid.appendChild(empty);
  }
}

function buildTabCard(tab, index) {
  const card = document.createElement("article");
  card.className = "tab-card";
  if (tab.active) card.classList.add("is-active");
  card.style.animationDelay = `${Math.min(index * 20, 160)}ms`;
  card.addEventListener("click", () => focusTab(tab));

  const preview = document.createElement("div");
  preview.className = "preview";

  const previewEntry = previewsState[tab.id];
  const isPreviewFresh = previewEntry && previewEntry.url === (tab.url || "");
  if (isPreviewFresh && previewEntry.image) {
    const img = document.createElement("img");
    img.src = previewEntry.image;
    img.alt = "";
    img.loading = "lazy";
    preview.appendChild(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "preview-placeholder";
    placeholder.textContent = isCapturableUrl(tab.url) ? "No preview" : "Blocked";
    preview.appendChild(placeholder);
  }

  const overlay = document.createElement("div");
  overlay.className = "preview-overlay";
  const closeButton = document.createElement("button");
  closeButton.className = "close-btn";
  closeButton.textContent = "x";
  closeButton.title = "Close tab";
  closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    chrome.tabs.remove(tab.id);
  });
  overlay.appendChild(closeButton);
  preview.appendChild(overlay);

  const meta = document.createElement("div");
  meta.className = "meta";

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  if (tab.favIconUrl) {
    const icon = document.createElement("img");
    icon.className = "favicon";
    icon.src = tab.favIconUrl;
    icon.alt = "";
    titleRow.appendChild(icon);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "favicon-fallback";
    fallback.textContent = getFallbackLetter(tab);
    titleRow.appendChild(fallback);
  }

  const title = document.createElement("h3");
  title.className = "title";
  title.textContent = tab.title || "Untitled tab";
  titleRow.appendChild(title);

  const url = document.createElement("p");
  url.className = "url";
  url.textContent = tab.url || "";

  meta.appendChild(titleRow);
  meta.appendChild(url);

  card.appendChild(preview);
  card.appendChild(meta);

  return card;
}

function focusTab(tab) {
  chrome.tabs.update(tab.id, { active: true }, () => {
    chrome.windows.update(tab.windowId, { focused: true }, () => {
      setTimeout(() => window.close(), 120);
    });
  });
}

function getSearchMatch(tab, query) {
  if (!query) return { rank: 0 };
  const url = (tab.url || "").toLowerCase();
  if (url.includes(query)) return { rank: 0 };
  const title = (tab.title || "").toLowerCase();
  if (title.includes(query)) return { rank: 1 };
  const bodyText = getBodyTextForTab(tab);
  if (bodyText && bodyText.includes(query)) return { rank: 2 };
  return null;
}

function getBodyTextForTab(tab) {
  const preview = previewsState[tab.id];
  if (!preview || !preview.bodyText) return "";
  return preview.bodyText.toLowerCase();
}

function getHost(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch (_error) {
    return url;
  }
}

function getFallbackLetter(tab) {
  const title = (tab.title || "").trim();
  if (title) return title[0].toUpperCase();
  const host = getHost(tab.url);
  return host ? host[0].toUpperCase() : "?";
}

function isCapturableUrl(url) {
  if (!url) return false;
  return !(
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("view-source:") ||
    url.startsWith("chrome-extension://")
  );
}

async function maybeRequestActiveCapture() {
  if (captureInFlight) return;
  const now = Date.now();
  if (now - lastCaptureRequestAt < AUTO_CAPTURE_COOLDOWN_MS) return;
  const activeTab = await getActiveTab();
  if (!activeTab || !isCapturableUrl(activeTab.url)) return;
  if (!isPreviewStale(activeTab, previewsState)) return;
  await requestActiveCapture();
}

async function requestActiveCapture() {
  if (captureInFlight) return;
  const now = Date.now();
  if (now - lastCaptureRequestAt < AUTO_CAPTURE_COOLDOWN_MS) return;
  const activeTab = await getActiveTab();
  if (!activeTab || !isCapturableUrl(activeTab.url)) return;
  captureInFlight = true;
  lastCaptureRequestAt = now;
  chrome.runtime.sendMessage({ type: "captureActive" }, (response) => {
    captureInFlight = false;
    if (chrome.runtime.lastError) {
      return;
    }
    if (!response || !response.ok) {
      return;
    }
    refresh();
  });
}

function isPreviewStale(tab, previews) {
  const entry = previews[tab.id];
  if (!entry || !entry.image) return true;
  if (entry.url !== (tab.url || "")) return true;
  if (!entry.capturedAt) return true;
  return Date.now() - entry.capturedAt > STALE_PREVIEW_AGE_MS;
}

function startAutoCapture() {
  if (autoCaptureTimer) clearInterval(autoCaptureTimer);
  autoCaptureTimer = setInterval(() => {
    maybeRequestActiveCapture();
  }, AUTO_CAPTURE_INTERVAL_MS);
  window.addEventListener("focus", () => {
    maybeRequestActiveCapture();
  });
}

function scheduleBodyTextSync() {
  if (!searchInput.value.trim()) return;
  if (bodySyncTimer) clearTimeout(bodySyncTimer);
  bodySyncTimer = setTimeout(syncBodyText, BODY_SYNC_DEBOUNCE_MS);
}

async function syncBodyText() {
  if (bodySyncInFlight) return;
  if (!searchInput.value.trim()) return;
  const now = Date.now();
  if (now - lastBodySyncAt < BODY_SYNC_COOLDOWN_MS) return;
  lastBodySyncAt = now;
  bodySyncInFlight = true;

  const tabs = windowsState
    .flatMap((win) => win.tabs || [])
    .filter((tab) => tab && tab.id !== undefined && isBodyReadableUrl(tab.url));
  const missing = tabs.filter((tab) => !hasBodyText(tab));
  if (missing.length === 0) {
    bodySyncInFlight = false;
    return;
  }

  const previews = await getPreviews();
  let updated = false;
  let processed = 0;
  for (const tab of missing) {
    if (processed >= BODY_SYNC_BATCH_LIMIT) break;
    const bodyText = await fetchBodyText(tab.id);
    if (!bodyText) continue;
    const key = String(tab.id);
    const existing = previews[key] || {};
    if (existing.bodyText === bodyText) continue;
    previews[key] = {
      ...existing,
      url: tab.url || existing.url || "",
      title: tab.title || existing.title || "",
      bodyText,
    };
    updated = true;
    processed += 1;
  }

  if (updated) {
    await setPreviews(previews);
  }

  bodySyncInFlight = false;
  if (missing.length > processed) {
    scheduleBodyTextSync();
  }
}

function hasBodyText(tab) {
  const preview = previewsState[tab.id];
  return Boolean(preview && typeof preview.bodyText === "string" && preview.bodyText.length > 0);
}

function isBodyReadableUrl(url) {
  return isCapturableUrl(url);
}

function fetchBodyText(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "getBodyText" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve("");
        return;
      }
      if (!response || !response.ok) {
        resolve("");
        return;
      }
      resolve(response.text || "");
    });
  });
}

function compareTabsByLastActive(a, b) {
  const scoreA = getLastActiveValue(a);
  const scoreB = getLastActiveValue(b);
  if (scoreA !== scoreB) return scoreB - scoreA;
  return (a.index || 0) - (b.index || 0);
}

function getLastActiveValue(tab) {
  const stored = lastActiveState[String(tab.id)];
  if (typeof stored === "number") return stored;
  if (typeof tab.lastAccessed === "number") return Math.floor(tab.lastAccessed);
  return 0;
}

async function reconcileLastActive(windows, lastActive) {
  const currentIds = new Set();
  const tabs = windows.flatMap((win) => win.tabs || []);
  tabs.forEach((tab) => {
    if (tab.id !== undefined) currentIds.add(String(tab.id));
  });

  let updated = false;
  for (const key of Object.keys(lastActive)) {
    if (!currentIds.has(key)) {
      delete lastActive[key];
      updated = true;
    }
  }

  tabs.forEach((tab) => {
    const key = String(tab.id);
    if (lastActive[key]) return;
    const seed = getLastActiveSeed(tab);
    if (seed) {
      lastActive[key] = seed;
      updated = true;
    }
  });

  if (updated) {
    await setLastActive(lastActive);
  }
}

function getLastActiveSeed(tab) {
  if (typeof tab.lastAccessed === "number") return Math.floor(tab.lastAccessed);
  if (tab.active) return Date.now();
  return 0;
}

function getWindows() {
  return new Promise((resolve) => {
    chrome.windows.getAll({ populate: true }, (windows) => {
      const normalWindows = (windows || []).filter((win) => win.type === "normal");
      normalWindows.sort((a, b) => Number(b.focused) - Number(a.focused));
      resolve(normalWindows);
    });
  });
}

function getPreviews() {
  return new Promise((resolve) => {
    chrome.storage.local.get(PREVIEW_KEY, (result) => {
      resolve(result[PREVIEW_KEY] || {});
    });
  });
}

function setPreviews(previews) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [PREVIEW_KEY]: previews }, () => resolve());
  });
}

function getLastActive() {
  return new Promise((resolve) => {
    chrome.storage.local.get(LAST_ACTIVE_KEY, (result) => {
      resolve(result[LAST_ACTIVE_KEY] || {});
    });
  });
}

function setLastActive(lastActive) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [LAST_ACTIVE_KEY]: lastActive }, () => resolve());
  });
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      resolve(tabs[0]);
    });
  });
}
