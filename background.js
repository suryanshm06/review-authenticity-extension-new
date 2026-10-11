// MV3 service worker: make the localhost request from the extension origin,
// not from Amazon/Flipkart's page origin. The extension host permission is in manifest.json.
const API_URL = "http://localhost:3000/api/detect-fakes";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "DETECT_REVIEWS") return false;

  if (!Array.isArray(message.reviews) || message.reviews.some((text) => typeof text !== "string")) {
    sendResponse({ ok: false, error: "Expected an array of review strings." });
    return false;
  }

  fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message.reviews)
  })
    .then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload && payload.error ? payload.error : `Local API returned HTTP ${response.status}.`);
      }
      if (!Array.isArray(payload)) throw new Error("Local API response was not a verdict array.");
      sendResponse({ ok: true, verdicts: payload });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  // Keeps this one event/message alive until sendResponse runs. The worker can
  // still go idle after the request; it is not a permanently running background page.
  return true;
});
