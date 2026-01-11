const PREVIEW_KEY = "tabPreviews";
const LAST_ACTIVE_KEY = "tabLastActive";
const SEARCH_KEY = "tabGallerySearch";
const AUTO_CAPTURE_COOLDOWN_MS = 30000;
const AUTO_CAPTURE_INTERVAL_MS = 60000;
const STALE_PREVIEW_AGE_MS = 3 * 60 * 1000;
const BODY_SYNC_DEBOUNCE_MS = 250;
const BODY_SYNC_COOLDOWN_MS = 1000;
const BODY_SYNC_BATCH_LIMIT = 20;
const SEARCH_SAVE_DEBOUNCE_MS = 200;

const grid = document.getElementById("tab-grid");
const searchInput = document.getElementById("search");
const operations = document.getElementById("operations");
const moveTabsButton = document.getElementById("move-tabs");
const closeTabsButton = document.getElementById("close-tabs");
const previewModal = document.getElementById("preview-modal");
const previewModalImage = document.getElementById("preview-modal-image");
const previewModalNote = document.getElementById("preview-modal-note");
const previewModalClose = document.getElementById("preview-modal-close");

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
const cardCache = new Map();
let emptyStateEl = null;
let isReady = false;
let lastOrder = [];
let searchSaveTimer = null;
let lastSavedSearch = "";
let modalReturnFocusEl = null;
let filteredTabsState = [];

init();

function init() {
  searchInput.addEventListener("input", () => {
    render();
    scheduleBodyTextSync();
    scheduleSearchSave();
  });
  moveTabsButton.addEventListener("click", () => moveFilteredTabs());
  closeTabsButton.addEventListener("click", () => closeFilteredTabs());

  previewModalClose.addEventListener("click", () => closePreviewModal());
  previewModal.addEventListener("click", (event) => {
    if (event.target === previewModal) {
      closePreviewModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && previewModal.classList.contains("active")) {
      closePreviewModal();
    }
  });
  window.addEventListener("beforeunload", () => saveSearchValue());

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
    if (!isReady) return;
    if (changes[PREVIEW_KEY]) {
      previewsState = changes[PREVIEW_KEY].newValue || {};
      render();
    }
    if (changes[LAST_ACTIVE_KEY]) {
      lastActiveState = changes[LAST_ACTIVE_KEY].newValue || {};
      render();
    }
  });

  loadSavedSearch().then(() => {
    registerLiveUpdates();
    refresh();
    startAutoCapture();
  });
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
  if (!isReady) {
    isReady = true;
  }
  await maybeRequestActiveCapture();
  scheduleBodyTextSync();
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  let cardIndex = 0;
  const rawTabs = windowsState.flatMap((win) => win.tabs || []);
  let tabs = rawTabs;
  const parsedQuery = query && isAdvancedQuery(query) ? parseQuery(tokenizeQuery(query)) : null;
  if (query) {
    const scored = rawTabs
      .map((tab) => {
        const match = getSearchMatch(tab, query, parsedQuery);
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

  const nextOrder = tabs.map((tab) => String(tab.id));
  const orderChanged =
    nextOrder.length !== lastOrder.length ||
    nextOrder.some((id, index) => id !== lastOrder[index]);

  const seen = new Set();
  const fragment = orderChanged ? document.createDocumentFragment() : null;

  tabs.forEach((tab) => {
    const key = String(tab.id);
    let card = cardCache.get(key);
    cardIndex += 1;
    if (!card) {
      card = buildTabCard(tab, cardIndex);
      if (isReady) {
        card.classList.add("animate");
      }
      cardCache.set(key, card);
    } else {
      updateTabCard(card, tab, cardIndex);
    }
    if (fragment) {
      fragment.appendChild(card);
    } else if (!card.isConnected) {
      grid.appendChild(card);
    }
    seen.add(key);
  });

  if (fragment) {
    grid.appendChild(fragment);
  }

  for (const [key, card] of cardCache.entries()) {
    if (!seen.has(key)) {
      card.remove();
      cardCache.delete(key);
    }
  }

  lastOrder = nextOrder;
  filteredTabsState = tabs;
  updateOperations(query, rawTabs.length, tabs.length);
  updateEmptyState(tabs.length, query);
}

function buildTabCard(tab, index) {
  const card = document.createElement("article");
  card.className = "tab-card";
  card.style.animationDelay = `${Math.min(index * 20, 160)}ms`;

  const preview = document.createElement("div");
  preview.className = "preview";

  const previewImage = document.createElement("img");
  previewImage.className = "preview-image";
  previewImage.alt = "";
  previewImage.loading = "lazy";
  previewImage.style.display = "none";
  preview.appendChild(previewImage);

  const placeholder = document.createElement("div");
  placeholder.className = "preview-placeholder";
  preview.appendChild(placeholder);

  const overlay = document.createElement("div");
  overlay.className = "preview-overlay";

  const maxButton = document.createElement("button");
  maxButton.className = "max-btn";
  maxButton.type = "button";
  maxButton.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />' +
    "</svg>";
  maxButton.title = "Maximize preview";
  overlay.appendChild(maxButton);

  const closeButton = document.createElement("button");
  closeButton.className = "close-btn";
  closeButton.type = "button";
  closeButton.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M6 6l12 12M18 6L6 18" ' +
    'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />' +
    "</svg>";
  closeButton.title = "Close tab";
  overlay.appendChild(closeButton);
  preview.appendChild(overlay);

  const meta = document.createElement("div");
  meta.className = "meta";

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  const icon = document.createElement("img");
  icon.className = "favicon";
  icon.alt = "";
  titleRow.appendChild(icon);

  const fallback = document.createElement("div");
  fallback.className = "favicon-fallback";
  titleRow.appendChild(fallback);

  const title = document.createElement("h3");
  title.className = "title";
  title.textContent = tab.title || "Untitled tab";
  titleRow.appendChild(title);

  const url = document.createElement("p");
  url.className = "url";
  url.innerHTML = formatUrlWithHighlights(tab.url || "");

  meta.appendChild(titleRow);
  meta.appendChild(url);

  card.appendChild(preview);
  card.appendChild(meta);

  card.tabGallery = {
    preview,
    previewImage,
    placeholder,
    icon,
    fallback,
    title,
    url,
    tabId: tab.id,
    tab,
  };

  card.addEventListener("click", () => focusTab(card.tabGallery.tab));
  maxButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openPreviewModal(card.tabGallery.tab);
  });
  closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    chrome.tabs.remove(card.tabGallery.tab.id);
  });

  updateTabCard(card, tab, index);
  return card;
}

function updateTabCard(card, tab, index) {
  if (!card.tabGallery) return;
  card.tabGallery.tabId = tab.id;
  card.tabGallery.tab = tab;
  if (tab.active) {
    card.classList.add("is-active");
  } else {
    card.classList.remove("is-active");
  }
  card.style.animationDelay = `${Math.min(index * 20, 160)}ms`;

  updatePreview(card.tabGallery, tab);
  updateFavicon(card.tabGallery, tab);

  if (card.tabGallery.title.textContent !== (tab.title || "Untitled tab")) {
    card.tabGallery.title.textContent = tab.title || "Untitled tab";
  }
  const urlHtml = formatUrlWithHighlights(tab.url || "");
  if (card.tabGallery.url.innerHTML !== urlHtml) {
    card.tabGallery.url.innerHTML = urlHtml;
  }
}

function updatePreview(refs, tab) {
  const previewEntry = previewsState[tab.id];
  const isPreviewFresh = previewEntry && previewEntry.url === (tab.url || "");
  if (isPreviewFresh && previewEntry.image) {
    if (refs.previewImage.src !== previewEntry.image) {
      refs.previewImage.src = previewEntry.image;
    }
    refs.previewImage.style.display = "block";
    refs.placeholder.style.display = "none";
  } else {
    refs.previewImage.style.display = "none";
    refs.placeholder.style.display = "grid";
    const text = isCapturableUrl(tab.url) ? "No preview" : "Blocked";
    if (refs.placeholder.textContent !== text) {
      refs.placeholder.textContent = text;
    }
  }
}

function updateFavicon(refs, tab) {
  if (tab.favIconUrl) {
    if (refs.icon.src !== tab.favIconUrl) {
      refs.icon.src = tab.favIconUrl;
    }
    refs.icon.style.display = "block";
    refs.fallback.style.display = "none";
  } else {
    refs.icon.style.display = "none";
    refs.fallback.style.display = "grid";
    const letter = getFallbackLetter(tab);
    if (refs.fallback.textContent !== letter) {
      refs.fallback.textContent = letter;
    }
  }
}

function updateEmptyState(count, query) {
  if (!emptyStateEl) {
    emptyStateEl = document.createElement("div");
    emptyStateEl.className = "empty";
  }
  if (count === 0) {
    emptyStateEl.textContent = query ? "No tabs match your search." : "No tabs found.";
    if (!grid.contains(emptyStateEl)) {
      grid.appendChild(emptyStateEl);
    }
  } else if (grid.contains(emptyStateEl)) {
    emptyStateEl.remove();
  }
}

function updateOperations(query, totalCount, filteredCount) {
  const hasQuery = Boolean(searchInput.value.trim());
  const shouldShow = hasQuery && Boolean(query) && filteredCount > 0 && filteredCount < totalCount;
  if (!shouldShow) {
    moveTabsButton.textContent = "";
    closeTabsButton.textContent = "";
    operations.hidden = true;
    operations.style.display = "none";
    return;
  }
  const labelCount = filteredCount;
  const suffix = labelCount === 1 ? "" : "s";
  moveTabsButton.textContent = `Move ${labelCount} tab${suffix} into a new window`;
  closeTabsButton.textContent = `Close ${labelCount} tab${suffix}`;
  operations.hidden = false;
  operations.style.display = "";
}

function getFilteredTabIds() {
  if (!filteredTabsState.length) return [];
  const ids = filteredTabsState
    .map((tab) => tab.id)
    .filter((id) => typeof id === "number");
  return [...new Set(ids)];
}

function moveFilteredTabs() {
  const tabIds = getFilteredTabIds();
  if (!tabIds.length) return;
  chrome.windows.create({ focused: true }, (win) => {
    if (chrome.runtime.lastError || !win) return;
    const windowId = win.id;
    const blankTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
    chrome.tabs.move(tabIds, { windowId, index: -1 }, () => {
      if (blankTabId) {
        chrome.tabs.remove(blankTabId);
      }
    });
  });
}

function closeFilteredTabs() {
  const tabIds = getFilteredTabIds();
  if (!tabIds.length) return;
  chrome.tabs.remove(tabIds);
}

function focusTab(tab) {
  chrome.tabs.update(tab.id, { active: true }, () => {
    chrome.windows.update(tab.windowId, { focused: true }, () => {
      setTimeout(() => window.close(), 120);
    });
  });
}

function openPreviewModal(tab) {
  modalReturnFocusEl = document.activeElement;
  const previewEntry = previewsState[tab.id];
  if (previewEntry && previewEntry.image) {
    previewModalImage.src = previewEntry.image;
    previewModalImage.alt = tab.title || "Preview";
    previewModalImage.style.display = "block";
    previewModalNote.textContent = "";
  } else {
    previewModalImage.removeAttribute("src");
    previewModalImage.style.display = "none";
    previewModalNote.textContent = isCapturableUrl(tab.url)
      ? "Preview not available yet."
      : "Preview blocked for this page.";
  }

  previewModal.hidden = false;
  previewModal.classList.add("active");
  requestAnimationFrame(() => {
    previewModalClose.focus({ preventScroll: true });
  });
}

function closePreviewModal() {
  previewModal.classList.remove("active");
  previewModal.hidden = true;
  previewModalImage.removeAttribute("src");
  previewModalNote.textContent = "";
  const returnTarget = modalReturnFocusEl;
  modalReturnFocusEl = null;
  if (returnTarget && document.contains(returnTarget)) {
    returnTarget.focus({ preventScroll: true });
  } else {
    searchInput.focus({ preventScroll: true });
  }
}

function getSearchMatch(tab, query, parsedQuery) {
  if (!query) return { rank: 0 };
  if (parsedQuery) {
    const result = evaluateQuery(parsedQuery, tab);
    if (!result.match) return null;
    return { rank: result.rank };
  }
  if (!isAdvancedQuery(query)) return getSimpleMatch(tab, query);
  const ast = parseQuery(tokenizeQuery(query));
  if (!ast) return getSimpleMatch(tab, query);
  const result = evaluateQuery(ast, tab);
  if (!result.match) return null;
  return { rank: result.rank };
}

function getBodyTextForTab(tab) {
  const preview = previewsState[tab.id];
  if (!preview || !preview.bodyText) return "";
  return preview.bodyText.toLowerCase();
}

function isAdvancedQuery(query) {
  return /[()]/.test(query) || /\b(and|or)\b/.test(query);
}

function getSimpleMatch(tab, query) {
  const rank = getTermRank(query, tab);
  if (rank === Infinity) return null;
  return { rank };
}

function getTermRank(term, tab) {
  if (!term) return Infinity;
  const urlRaw = (tab.url || "").toLowerCase();
  const urlDecoded = safeDecode(tab.url || "").toLowerCase();
  if (urlRaw.includes(term) || urlDecoded.includes(term)) return 0;
  const title = (tab.title || "").toLowerCase();
  if (title.includes(term)) return 1;
  const bodyText = getBodyTextForTab(tab);
  if (bodyText && bodyText.includes(term)) return 2;
  return Infinity;
}

function tokenizeQuery(query) {
  const tokens = [];
  let i = 0;
  while (i < query.length) {
    const char = query[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ type: char });
      i += 1;
      continue;
    }
    let start = i;
    while (i < query.length && !/\s/.test(query[i]) && query[i] !== "(" && query[i] !== ")") {
      i += 1;
    }
    const value = query.slice(start, i);
    if (value === "and" || value === "or") {
      tokens.push({ type: value });
    } else {
      tokens.push({ type: "term", value });
    }
  }
  return tokens;
}

function parseQuery(tokens) {
  let index = 0;

  const peek = () => tokens[index];
  const match = (type) => {
    const token = tokens[index];
    if (!token || token.type !== type) return null;
    index += 1;
    return token;
  };

  const parseExpression = () => parseOr();

  const parseOr = () => {
    let node = parseAnd();
    if (!node) return null;
    while (match("or")) {
      const right = parseAnd();
      if (!right) return null;
      node = { type: "or", left: node, right };
    }
    return node;
  };

  const parseAnd = () => {
    let node = parsePrimary();
    if (!node) return null;
    while (true) {
      if (match("and")) {
        const right = parsePrimary();
        if (!right) return null;
        node = { type: "and", left: node, right };
        continue;
      }
      const next = peek();
      if (next && (next.type === "term" || next.type === "(")) {
        const right = parsePrimary();
        if (!right) return null;
        node = { type: "and", left: node, right };
        continue;
      }
      break;
    }
    return node;
  };

  const parsePrimary = () => {
    if (match("(")) {
      const node = parseExpression();
      if (!node || !match(")")) return null;
      return node;
    }
    const termToken = match("term");
    if (termToken) {
      return { type: "term", value: termToken.value };
    }
    return null;
  };

  const ast = parseExpression();
  if (!ast) return null;
  if (index < tokens.length) return null;
  return ast;
}

function evaluateQuery(node, tab) {
  if (!node) return { match: false, rank: Infinity };
  if (node.type === "term") {
    const rank = getTermRank(node.value, tab);
    return { match: rank !== Infinity, rank };
  }
  if (node.type === "and") {
    const left = evaluateQuery(node.left, tab);
    if (!left.match) return { match: false, rank: Infinity };
    const right = evaluateQuery(node.right, tab);
    if (!right.match) return { match: false, rank: Infinity };
    return { match: true, rank: Math.min(left.rank, right.rank) };
  }
  if (node.type === "or") {
    const left = evaluateQuery(node.left, tab);
    const right = evaluateQuery(node.right, tab);
    if (!left.match && !right.match) return { match: false, rank: Infinity };
    if (left.match && right.match) return { match: true, rank: Math.min(left.rank, right.rank) };
    return left.match ? left : right;
  }
  return { match: false, rank: Infinity };
}

function formatUrlWithHighlights(rawUrl) {
  if (!rawUrl) return "";
  const parts = splitUrl(rawUrl);
  const base = safeDecode(parts.base);
  const queryHtml = parts.query ? buildQueryHtml(parts.query) : "";
  const hashText = parts.hash ? `#${escapeHtml(safeDecode(parts.hash))}` : "";
  const baseHtml = escapeHtml(base);
  if (!queryHtml && !hashText) return baseHtml;
  return `${baseHtml}${queryHtml ? "?" + queryHtml : ""}${hashText}`;
}

function splitUrl(rawUrl) {
  const hashIndex = rawUrl.indexOf("#");
  const beforeHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
  const hash = hashIndex >= 0 ? rawUrl.slice(hashIndex + 1) : "";
  const queryIndex = beforeHash.indexOf("?");
  const base = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : "";
  return { base, query, hash };
}

function buildQueryHtml(query) {
  if (!query) return "";
  const parts = query.split("&");
  const rendered = parts.map((part) => {
    if (!part) return "";
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) {
      return escapeHtml(safeDecode(part));
    }
    const key = part.slice(0, eqIndex);
    const value = part.slice(eqIndex + 1);
    const decodedKey = safeDecode(key);
    const decodedValue = safeDecode(value);
    const valueHtml = decodedValue
      ? `<span class="url-value">${escapeHtml(decodedValue)}</span>`
      : "";
    return `${escapeHtml(decodedKey)}=${valueHtml}`;
  });
  return rendered.join("&");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
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

function loadSavedSearch() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SEARCH_KEY, (result) => {
      const saved = result[SEARCH_KEY];
      if (typeof saved === "string") {
        searchInput.value = saved;
        lastSavedSearch = saved;
      }
      resolve();
    });
  });
}

function scheduleSearchSave() {
  if (searchSaveTimer) clearTimeout(searchSaveTimer);
  searchSaveTimer = setTimeout(saveSearchValue, SEARCH_SAVE_DEBOUNCE_MS);
}

function saveSearchValue() {
  const value = searchInput.value || "";
  if (value === lastSavedSearch) return;
  lastSavedSearch = value;
  chrome.storage.local.set({ [SEARCH_KEY]: value });
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
  const stored = typeof lastActiveState[String(tab.id)] === "number"
    ? lastActiveState[String(tab.id)]
    : 0;
  const lastAccessed =
    typeof tab.lastAccessed === "number" ? Math.floor(tab.lastAccessed) : 0;
  return Math.max(stored, lastAccessed);
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
