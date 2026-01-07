const PREVIEW_KEY = "tabPreviews";
const LAST_ACTIVE_KEY = "tabLastActive";
const MAX_PREVIEWS = 80;
const CAPTURE_DELAY_MS = 350;
const CAPTURE_THROTTLE_MS = 10000;
const PREVIEW_WIDTH = 2048;
const PREVIEW_HEIGHT = 1536;
const PREVIEW_QUALITY = 0.9;

let capturingAll = false;
const lastCaptureByTab = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ ok: false, error: "Unknown message" });
    return;
  }

  if (message.type === "captureAll") {
    captureAllTabs(Boolean(message.currentWindowOnly))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "captureActive") {
    captureActiveTab()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  sendResponse({ ok: false, error: "Unhandled message type" });
});

chrome.tabs.onActivated.addListener(async (info) => {
  if (capturingAll) return;
  const tab = await getTab(info.tabId);
  if (!tab || !tab.active) return;
  await updateLastActive(tab.id);
  if (!isCapturable(tab)) return;
  if (!shouldCapture(tab.id)) return;
  await captureAndStore(tab, info.windowId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    await removePreview(tabId);
  }
  if (changeInfo.status === "complete" && tab.active && !capturingAll) {
    if (!isCapturable(tab)) return;
    if (!shouldCapture(tabId)) return;
    await captureAndStore(tab, tab.windowId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await removePreview(tabId);
  await removeLastActive(tabId);
});

async function captureActiveTab() {
  const tabs = await queryTabs({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab) return { ok: false, error: "No active tab found" };
  if (!isCapturable(tab)) {
    return { ok: false, error: "Active tab cannot be captured" };
  }
  const result = await captureAndStore(tab, tab.windowId);
  return result;
}

async function captureAllTabs(currentWindowOnly) {
  capturingAll = true;
  try {
    const rawWindows = currentWindowOnly
      ? [await getCurrentWindow({ populate: true })]
      : await getAllWindows({ populate: true });
    const windows = rawWindows.filter((win) => win && win.type === "normal");

    const capturableTabs = [];
    for (const win of windows) {
      for (const tab of win.tabs || []) {
        if (isCapturable(tab)) {
          capturableTabs.push(tab);
        }
      }
    }

    const total = capturableTabs.length;
    sendMessage({ type: "captureStart", total });

    let completed = 0;
    const activeByWindow = new Map();
    const focusedWindowId = windows.find((win) => win.focused)?.id;

    for (const win of windows) {
      const activeTab = (win.tabs || []).find((tab) => tab.active);
      if (activeTab) activeByWindow.set(win.id, activeTab.id);
    }

    for (const win of windows) {
      await updateWindow(win.id, { focused: true });
      for (const tab of win.tabs || []) {
        if (!isCapturable(tab)) {
          sendMessage({
            type: "captureProgress",
            current: completed,
            total,
            tabId: tab.id,
            ok: false,
            error: "restricted",
          });
          continue;
        }

        await updateTab(tab.id, { active: true });
        await delay(CAPTURE_DELAY_MS);

        const result = await captureAndStore(tab, win.id);
        completed += 1;
        sendMessage({
          type: "captureProgress",
          current: completed,
          total,
          tabId: tab.id,
          ok: result.ok,
          error: result.error,
        });
      }
    }

    for (const [windowId, tabId] of activeByWindow.entries()) {
      await updateTab(tabId, { active: true });
      await updateWindow(windowId, { focused: true });
    }

    if (focusedWindowId) {
      await updateWindow(focusedWindowId, { focused: true });
    }

    sendMessage({ type: "captureDone", total, captured: completed });
  } finally {
    capturingAll = false;
  }
}

async function captureAndStore(tab, windowId) {
  const capture = await captureVisible(windowId);
  if (!capture.ok) return capture;

  const [resized, bodyText] = await Promise.all([
    resizeDataUrl(capture.dataUrl, PREVIEW_WIDTH, PREVIEW_HEIGHT),
    getBodyText(tab.id),
  ]);
  const previews = await getPreviews();
  previews[tab.id] = {
    image: resized,
    url: tab.url || "",
    title: tab.title || "",
    capturedAt: Date.now(),
    windowId: tab.windowId,
    bodyText,
  };
  prunePreviews(previews, MAX_PREVIEWS);
  await setPreviews(previews);
  return { ok: true };
}

function isCapturable(tab) {
  if (!tab || !tab.url || tab.incognito) return false;
  const url = tab.url;
  return !(
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("view-source:") ||
    url.startsWith("chrome-extension://")
  );
}

function shouldCapture(tabId) {
  const now = Date.now();
  const lastCapture = lastCaptureByTab.get(tabId) || 0;
  if (now - lastCapture < CAPTURE_THROTTLE_MS) {
    return false;
  }
  lastCaptureByTab.set(tabId, now);
  return true;
}

async function removePreview(tabId) {
  const previews = await getPreviews();
  if (!previews[tabId]) return;
  delete previews[tabId];
  await setPreviews(previews);
}

function prunePreviews(previews, max) {
  const entries = Object.entries(previews);
  if (entries.length <= max) return;
  entries.sort((a, b) => (b[1].capturedAt || 0) - (a[1].capturedAt || 0));
  const keep = new Set(entries.slice(0, max).map(([id]) => id));
  for (const id of Object.keys(previews)) {
    if (!keep.has(id)) delete previews[id];
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resizeDataUrl(dataUrl, targetWidth, targetHeight) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return dataUrl;
  }
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    if (!bitmap.width || !bitmap.height) return dataUrl;
    const width = Math.max(1, Math.round(targetWidth));
    const height = Math.max(1, Math.round(targetHeight));
    const scale = Math.max(width / bitmap.width, height / bitmap.height);
    const drawWidth = Math.max(1, Math.round(bitmap.width * scale));
    const drawHeight = Math.max(1, Math.round(bitmap.height * scale));
    const dx = Math.round((width - drawWidth) / 2);
    const dy = Math.round((height - drawHeight) / 2);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, dx, dy, drawWidth, drawHeight);
    const output = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: PREVIEW_QUALITY,
    });
    return await blobToDataUrl(output);
  } catch (_error) {
    return dataUrl;
  }
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function sendMessage(message) {
  chrome.runtime.sendMessage(message);
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

function getBodyText(tabId) {
  return new Promise((resolve) => {
    if (tabId === undefined || tabId === null) {
      resolve("");
      return;
    }
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

async function updateLastActive(tabId) {
  const lastActive = await getLastActive();
  lastActive[String(tabId)] = Date.now();
  await setLastActive(lastActive);
}

async function removeLastActive(tabId) {
  const lastActive = await getLastActive();
  const key = String(tabId);
  if (!lastActive[key]) return;
  delete lastActive[key];
  await setLastActive(lastActive);
}

function captureVisible(windowId) {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(
      windowId,
      { format: "jpeg", quality: 90 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true, dataUrl });
      }
    );
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

function updateTab(tabId, props) {
  return new Promise((resolve) => chrome.tabs.update(tabId, props, resolve));
}

function updateWindow(windowId, props) {
  return new Promise((resolve) => chrome.windows.update(windowId, props, resolve));
}

function getCurrentWindow(getInfo) {
  return new Promise((resolve) => chrome.windows.getCurrent(getInfo, resolve));
}

function getAllWindows(getInfo) {
  return new Promise((resolve) => chrome.windows.getAll(getInfo, resolve));
}

function getTab(tabId) {
  return new Promise((resolve) => chrome.tabs.get(tabId, resolve));
}
