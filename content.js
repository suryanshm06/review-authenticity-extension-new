(() => {
  "use strict";

  const BATCH_SIZE = 10;
  const FLUSH_DELAY_MS = 350;
  const RESCAN_DELAY_MS = 250;
  const BADGE_CLASS = "ml-fake-review-badge";
  const BADGE_TEXT = "⚠️ AI flagged as likely fake.";

  // Keep selectors centralized here so they are easy to update when the sites change.
  const SITE_SELECTORS = {
    amazon: {
      reviewCardSelectors: ['[data-hook="review"]'],
      reviewTextSelectors: [
        '[data-hook="review-title"]',
        '[data-hook="review-body"]'
      ],
      reviewRatingSelectors: [
        '[data-hook="review-star-rating"] .a-icon-alt',
        '[data-hook="cmps-review-star-rating"] .a-icon-alt'
      ]
    },
    flipkart: {
      reviewCardSelectors: [
        '[data-testid="review-card"]',
        "div.col._2wzgFH.K0kLPL",
        'div[class*="_2wzgFH"][class*="K0kLPL"]',
        '[class*="review-card"]'
      ],
      reviewTextSelectors: [
        '[data-testid="review-text"]',
        "div.t-ZTKy",
        "div.ZmyHeo",
        "div._3gijNv"
      ],
      reviewRatingSelectors: [
        '[data-testid="review-rating"]',
        "div._3LWZlK",
        "div.XQDdHH"
      ]
    }
  };

  const hostname = window.location.hostname.toLowerCase();
  let siteConfig = null;

  if (/(^|\.)amazon\.(in|com)$/i.test(hostname)) {
    siteConfig = SITE_SELECTORS.amazon;
  } else if (/(^|\.)flipkart\.com$/i.test(hostname)) {
    siteConfig = SITE_SELECTORS.flipkart;
  }

  if (!siteConfig) return;

  const pendingReviews = [];
  let isFlushing = false;
  let flushTimer = null;
  let rescanTimer = null;
  let batchSequence = 0;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function extractReviewText(card) {
    const parts = [];

    for (const selector of siteConfig.reviewTextSelectors) {
      for (const node of card.querySelectorAll(selector)) {
        const text = normalizeText(node.innerText || node.textContent);
        if (text && !parts.includes(text)) parts.push(text);
      }
    }

    // Fallback for a changed/unknown site layout. Prefer updating reviewTextSelectors
    // above when the site's DOM changes.
    return parts.length
      ? parts.join(" ")
      : normalizeText(card.innerText || card.textContent);
  }

  function extractReviewRating(card) {
    for (const selector of siteConfig.reviewRatingSelectors || []) {
      const node = card.querySelector(selector);
      if (!node) continue;

      const raw = normalizeText(
        node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent
      );
      const match = raw.match(/\b([1-5](?:\.\d)?)\b/);
      if (match) {
        const rating = Number(match[1]);
        if (rating >= 1 && rating <= 5) return rating;
      }
    }
    return null;
  }

  function getReviewCards(root) {
    const cards = new Set();

    for (const selector of siteConfig.reviewCardSelectors) {
      try {
        if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) cards.add(root);
        root.querySelectorAll(selector).forEach((card) => cards.add(card));
      } catch (error) {
        console.warn("[Review Highlighter] Invalid review selector:", selector, error);
      }
    }

    return cards;
  }

  function enqueueReview(card) {
    if (card.getAttribute("data-ml-processed") === "true") return;

    const text = extractReviewText(card);
    if (!text) return;

    const rating = extractReviewRating(card);
    // The GitHub model was trained with a rating prefix (for example, "5 stars. ...").
    const modelText = rating === null ? text : `${rating} stars. ${text}`;

    card.setAttribute("data-ml-processed", "true");
    card.setAttribute("data-ml-status", "queued");
    pendingReviews.push({ element: card, text: modelText });
    scheduleFlush();
  }

  function scanReviews(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    for (const card of getReviewCards(root)) enqueueReview(card);
  }

  function scheduleFlush(delay = FLUSH_DELAY_MS) {
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      void flushPendingReviews();
    }, delay);
  }

  async function flushPendingReviews() {
    if (isFlushing) return;
    isFlushing = true;

    try {
      while (pendingReviews.length > 0) {
        const batch = pendingReviews.splice(0, BATCH_SIZE);
        await sendBatch(batch);
      }
    } finally {
      isFlushing = false;
      if (pendingReviews.length > 0) scheduleFlush(0);
    }
  }

  async function sendBatch(batch) {
    const thisBatch = ++batchSequence;
    const itemByResponseId = new Map();

    batch.forEach((item, index) => {
      const responseId = String(index);
      item.element.setAttribute("data-ml-review-id", `${thisBatch}-${responseId}`);
      item.element.setAttribute("data-ml-status", "sending");
      itemByResponseId.set(responseId, item);
    });

    try {
      // The worker calls localhost using extension permissions. This avoids making
      // Amazon/Flipkart itself the origin of the local-network request.
      const messageResponse = await chrome.runtime.sendMessage({
        type: "DETECT_REVIEWS",
        reviews: batch.map((item) => item.text)
      });

      if (!messageResponse || !messageResponse.ok) {
        throw new Error(messageResponse && messageResponse.error ? messageResponse.error : "No response from extension service worker.");
      }

      const verdicts = messageResponse.verdicts;
      if (!Array.isArray(verdicts)) throw new Error("Local API response must be an array of verdict objects.");

      const handled = new Set();
      for (const verdict of verdicts) {
        if (!verdict || (typeof verdict.reviewId !== "string" && typeof verdict.reviewId !== "number")) continue;

        const item = itemByResponseId.get(String(verdict.reviewId));
        if (!item || typeof verdict.isFake !== "boolean") continue;

        handled.add(item);
        item.element.setAttribute("data-ml-status", "complete");
        if (verdict.isFake) highlightReview(item.element);
      }

      for (const item of batch) {
        if (!handled.has(item)) item.element.setAttribute("data-ml-status", "error");
      }

      if (handled.size !== batch.length) {
        console.warn("[Review Highlighter] The API returned missing or invalid verdicts for part of a batch.");
      }
    } catch (error) {
      for (const item of batch) item.element.setAttribute("data-ml-status", "error");
      console.warn("[Review Highlighter] Could not analyze reviews:", error);
    }
  }

  function highlightReview(card) {
    card.classList.add("fake-review-highlight");
    card.setAttribute("data-ml-fake", "true");

    const alreadyHasBadge = Array.from(card.children).some((child) => child.classList.contains(BADGE_CLASS));
    if (alreadyHasBadge) return;

    const badge = document.createElement("div");
    badge.className = BADGE_CLASS;
    badge.setAttribute("role", "status");
    badge.textContent = BADGE_TEXT;
    card.insertBefore(badge, card.firstChild);
  }

  function scheduleRescan() {
    if (rescanTimer !== null) window.clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => {
      rescanTimer = null;
      scanReviews(document);
    }, RESCAN_DELAY_MS);
  }

  const observer = new MutationObserver((mutations) => {
    const hasRelevantAddition = mutations.some((mutation) =>
      Array.from(mutation.addedNodes).some((node) =>
        !(node.nodeType === Node.ELEMENT_NODE && node.classList.contains(BADGE_CLASS))
      )
    );
    if (hasRelevantAddition) scheduleRescan();
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  scanReviews(document);
})();
