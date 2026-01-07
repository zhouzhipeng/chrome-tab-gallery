const MAX_BODY_CHARS = 20000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "getBodyText") return;
  try {
    const body = document.body;
    const rawText = body ? body.innerText || body.textContent || "" : "";
    const normalized = rawText.replace(/\s+/g, " ").trim();
    const trimmed = normalized.slice(0, MAX_BODY_CHARS);
    sendResponse({ ok: true, text: trimmed });
  } catch (error) {
    sendResponse({ ok: false, error: String(error) });
  }
  return true;
});
