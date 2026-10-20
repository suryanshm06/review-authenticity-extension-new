(() => {
  "use strict";

  const BATCH_SIZE = 10;
  const FLUSH_DELAY_MS = 350;
  const RESCAN_DELAY_MS = 250;
  const BADGE_CLASS = "ml-fake-review-badge";
  const BADGE_TEXT = "⚠️ AI flagged as likely fake.";
  const RATING_WIDGET_ID = "ml-unflagged-rating-widget";

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
      ],
      productRatingSelectors: [
        '#acrPopover .a-icon-alt',
        '#averageCustomerReviews .a-icon-alt',
        '[data-hook="rating-out-of-text"]',
        '#acrPopover'
      ]
    },
    flipkart: {
      reviewCardSelectors: [
        '[data-testid="review-card"]',
        "div.col._2wzgFH.K0kLPL",
        'div[class*="_2wzgFH"][class*="K0kLPL"]',
        "div.col.EPCmJX.Ma1fCG",
        'div[class*="EPCmJX"][class*="Ma1fCG"]',
        '[class*="review-card"]'
      ],
      reviewTextSelectors: [
        '[data-testid="review-text"]',
        "p.z9E0IG",
        "div.t-ZTKy",
        "div.ZmyHeo",
        "div._3gijNv"
      ],
      reviewRatingSelectors: [
        '[data-testid="review-rating"]',
        "div._3LWZlK",
        "div.XQDdHH"
      ],
      productRatingSelectors: [
        'div[class*="ratingAndReviews"] .XQDdHH',
        'div[class*="ratingAndReviews"] ._3LWZlK',
        "div.XQDdHH",
        "div._3LWZlK"
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
  let ratingUi = null;

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

    // Flipkart changes generated class names periodically. Fall back to a
    // standalone rating label such as "5.0 • Wonderful" within the card.
    if (siteConfig === SITE_SELECTORS.flipkart) {
      for (const node of card.querySelectorAll("span, div, p")) {
        const rating = parseFlipkartRatingNode(node);
        if (rating !== null) return rating;
      }
    }
    return null;
  }

  function parseRating(rawValue) {
    const raw = normalizeText(rawValue);
    const match = raw.match(/\b([1-5](?:\.\d)?)\b/);
    if (!match) return null;
    const rating = Number(match[1]);
    return rating >= 1 && rating <= 5 ? rating : null;
  }

  function parseFlipkartRatingNode(node) {
    const raw = normalizeText(
      node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent
    );
    if (!raw || raw.length > 50) return null;

    // Flipkart commonly renders the review score alone or followed by a title,
    // for example: "5.0 • Wonderful".
    const match = raw.match(/^([1-5](?:\.\d)?)\s*(?:(?:[•·|–—-])\s*.*)?$/);
    if (!match) return null;
    const rating = Number(match[1]);
    return rating >= 1 && rating <= 5 ? rating : null;
  }

  function findFlipkartReviewCard(ratingNode) {
    let current = ratingNode.parentElement;
    for (let depth = 0; current && current !== document.body && depth < 12; depth += 1, current = current.parentElement) {
      const text = normalizeText(current.innerText || current.textContent);
      if (text.length > 2500) break;

      const reviewForCount = (text.match(/\bReview for:/gi) || []).length;
      const verifiedCount = (text.match(/\bVerified Purchase\b/gi) || []).length;
      const certifiedCount = (text.match(/\bCertified Buyer\b/gi) || []).length;
      if (reviewForCount > 1 || verifiedCount > 1 || certifiedCount > 1) break;

      if (reviewForCount === 1 || verifiedCount === 1 || certifiedCount === 1) {
        return current;
      }
    }
    return null;
  }

  function extractProductRating() {
    const detectedFlipkartCards = siteConfig === SITE_SELECTORS.flipkart
      ? getReviewCards(document)
      : null;

    for (const selector of siteConfig.productRatingSelectors || []) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (error) {
        console.warn("[Review Highlighter] Invalid product-rating selector:", selector, error);
        continue;
      }

      for (const node of nodes) {
        const insideSelectorReview = siteConfig.reviewCardSelectors.some((reviewSelector) => {
          try {
            return Boolean(node.closest(reviewSelector));
          } catch {
            return false;
          }
        });
        const insideDetectedReview = Boolean(
          detectedFlipkartCards && Array.from(detectedFlipkartCards).some((card) => card.contains(node))
        );
        if (insideSelectorReview || insideDetectedReview) continue;

        const raw = node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent;
        const rating = parseRating(raw);
        if (rating !== null) return rating;
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

    // Selector fallback for Flipkart's frequently changing generated classes.
    // Find standalone numeric review ratings, then climb to the nearest ancestor
    // containing a unique "Review for", "Verified Purchase", or "Certified Buyer" marker.
    if (siteConfig === SITE_SELECTORS.flipkart) {
      const ratingNodes = [];
      if (root.nodeType === Node.ELEMENT_NODE && parseFlipkartRatingNode(root)) ratingNodes.push(root);
      root.querySelectorAll("span, div, p").forEach((node) => {
        if (parseFlipkartRatingNode(node) !== null) ratingNodes.push(node);
      });
      for (const ratingNode of ratingNodes) {
        const card = findFlipkartReviewCard(ratingNode);
        if (card) cards.add(card);
      }
    }

    return cards;
  }

  function enqueueReview(card) {
    if (card.getAttribute("data-ml-processed") === "true") return;

    const text = extractReviewText(card);
    if (!text) return;

    const rating = extractReviewRating(card);
    // The GitHub model was trained with text prefixed like "5 stars. ...".
    const modelText = rating === null ? text : `${rating} stars. ${text}`;

    card.setAttribute("data-ml-processed", "true");
    card.setAttribute("data-ml-status", "queued");
    if (rating === null) {
      card.removeAttribute("data-ml-rating");
    } else {
      card.setAttribute("data-ml-rating", String(rating));
    }
    pendingReviews.push({ element: card, text: modelText, rating });
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
      if (pendingReviews.length > 0) {
        scheduleFlush(0);
      } else {
        updateRatingPanelIfOpen();
      }
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
        item.element.setAttribute("data-ml-fake", String(verdict.isFake));
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
    } finally {
      updateRatingPanelIfOpen();
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

  function createRatingWidget() {
    if (document.getElementById(RATING_WIDGET_ID)) return;

    const widget = document.createElement("div");
    widget.id = RATING_WIDGET_ID;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ml-rating-toggle";
    toggle.textContent = "Show adjusted rating";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "ml-unflagged-rating-panel");

    const panel = document.createElement("section");
    panel.id = "ml-unflagged-rating-panel";
    panel.className = "ml-rating-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Detailed rating from unflagged reviews");

    const header = document.createElement("div");
    header.className = "ml-rating-header";

    const title = document.createElement("h2");
    title.className = "ml-rating-title";
    title.textContent = "Review rating summary";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ml-rating-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close adjusted rating panel");

    const value = document.createElement("div");
    value.className = "ml-rating-value";
    value.setAttribute("aria-live", "polite");
    value.textContent = "Not calculated yet";

    const comparison = document.createElement("p");
    comparison.className = "ml-rating-comparison";
    comparison.textContent = "Product-page rating comparison will appear here when detected.";

    const stats = document.createElement("div");
    stats.className = "ml-rating-stats";
    const makeStat = (label) => {
      const item = document.createElement("div");
      item.className = "ml-rating-stat";
      const number = document.createElement("span");
      number.className = "ml-rating-stat-number";
      const caption = document.createElement("span");
      caption.className = "ml-rating-stat-label";
      caption.textContent = label;
      item.append(number, caption);
      stats.appendChild(item);
      return number;
    };
    const includedStat = makeStat("Included");
    const excludedStat = makeStat("Excluded");
    const flaggedStat = makeStat("Model-flagged");
    const unratedStat = makeStat("Unrated");
    const failedStat = makeStat("Failed");

    const distributionTitle = document.createElement("h3");
    distributionTitle.className = "ml-rating-distribution-title";
    distributionTitle.textContent = "Star distribution of included reviews";

    const distribution = document.createElement("div");
    distribution.className = "ml-rating-distribution";
    distribution.setAttribute("aria-label", "Included review star distribution");

    const details = document.createElement("p");
    details.className = "ml-rating-details";

    const note = document.createElement("p");
    note.className = "ml-rating-note";
    note.textContent = "Based only on rated reviews currently loaded and analyzed on this page. Unflagged does not prove a review is human-written. Distribution groups ratings to the nearest half-star.";

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "ml-rating-refresh";
    refresh.textContent = "Recalculate";

    header.append(title, close);
    panel.append(header, value, comparison, stats, distributionTitle, distribution, details, note, refresh);
    widget.append(toggle, panel);

    toggle.addEventListener("click", () => {
      const opening = panel.hidden;
      panel.hidden = !opening;
      toggle.setAttribute("aria-expanded", String(opening));
      if (opening) {
        scanReviews(document);
        updateRatingPanel();
      }
    });

    close.addEventListener("click", () => {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    });

    refresh.addEventListener("click", () => {
      scanReviews(document);
      updateRatingPanel();
    });

    (document.body || document.documentElement).appendChild(widget);
    ratingUi = {
      panel,
      value,
      comparison,
      includedStat,
      excludedStat,
      flaggedStat,
      unratedStat,
      failedStat,
      distribution,
      details
    };
  }

  function updateRatingPanelIfOpen() {
    if (ratingUi && !ratingUi.panel.hidden) updateRatingPanel();
  }

  function updateRatingPanel() {
    if (!ratingUi) return;

    const completed = Array.from(document.querySelectorAll('[data-ml-status="complete"]'));
    const unflagged = completed.filter((card) => card.getAttribute("data-ml-fake") === "false");
    const flaggedCount = completed.filter((card) => card.getAttribute("data-ml-fake") === "true").length;
    const failedCount = document.querySelectorAll('[data-ml-status="error"]').length;
    const inProgress = document.querySelectorAll(
      '[data-ml-status="queued"], [data-ml-status="sending"]'
    ).length;
    const ratings = unflagged
      .map((card) => Number(card.getAttribute("data-ml-rating")))
      .filter((rating) => Number.isFinite(rating) && rating >= 1 && rating <= 5);
    const unratedCount = Math.max(0, unflagged.length - ratings.length);
    const excludedCount = flaggedCount + unratedCount + failedCount;
    const pageRating = extractProductRating();

    ratingUi.includedStat.textContent = String(ratings.length);
    ratingUi.excludedStat.textContent = String(excludedCount);
    ratingUi.flaggedStat.textContent = String(flaggedCount);
    ratingUi.unratedStat.textContent = String(unratedCount);
    ratingUi.failedStat.textContent = String(failedCount);
    ratingUi.comparison.textContent = pageRating === null
      ? "Product-page average: not detected on this layout."
      : `Product-page average: ${pageRating.toFixed(1)} / 5 stars.`;

    const bins = [5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1];
    const counts = new Map(bins.map((star) => [star, 0]));
    for (const rating of ratings) {
      const bin = Math.min(5, Math.max(1, Math.round(rating * 2) / 2));
      counts.set(bin, (counts.get(bin) || 0) + 1);
    }
    ratingUi.distribution.replaceChildren();

    if (ratings.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ml-rating-empty-distribution";
      empty.textContent = "No rated, unflagged reviews to chart yet.";
      ratingUi.distribution.appendChild(empty);
    } else {
      for (const star of bins) {
        const count = counts.get(star) || 0;
        const percent = Math.round((count / ratings.length) * 100);
        const row = document.createElement("div");
        row.className = "ml-rating-dist-row";
        const label = document.createElement("span");
        label.className = "ml-rating-dist-label";
        label.textContent = `${Number.isInteger(star) ? star : star.toFixed(1)} ★`;
        const track = document.createElement("span");
        track.className = "ml-rating-dist-track";
        const bar = document.createElement("span");
        bar.className = "ml-rating-dist-bar";
        bar.style.width = `${percent}%`;
        track.appendChild(bar);
        const countLabel = document.createElement("span");
        countLabel.className = "ml-rating-dist-count";
        countLabel.textContent = `${count} (${percent}%)`;
        row.append(label, track, countLabel);
        ratingUi.distribution.appendChild(row);
      }
    }

    if (inProgress > 0 || isFlushing) {
      ratingUi.value.textContent = "Analyzing reviews…";
      ratingUi.details.textContent = `${inProgress} review(s) are queued or being analyzed. The summary will update when analysis finishes.`;
      return;
    }

    if (ratings.length === 0) {
      ratingUi.value.textContent = "No adjusted average yet";
      ratingUi.details.textContent = completed.length === 0
        ? `No reviews have finished analysis. ${failedCount} review(s) failed. Scroll to load reviews, then select Recalculate.`
        : `Analyzed ${completed.length} review(s): ${flaggedCount} flagged, ${unratedCount} unflagged without a readable rating, and ${failedCount} failed.`;
      return;
    }

    const average = ratings.reduce((total, rating) => total + rating, 0) / ratings.length;
    ratingUi.value.textContent = `${average.toFixed(1)} / 5 stars`;
    if (pageRating === null) {
      ratingUi.comparison.textContent = "Product-page average: not detected on this layout.";
    } else {
      const delta = Math.round((average - pageRating) * 10) / 10;
      ratingUi.comparison.textContent = Math.abs(delta) < 0.1
        ? `Product-page average: ${pageRating.toFixed(1)} / 5; the unflagged average is about the same.`
        : `Product-page average: ${pageRating.toFixed(1)} / 5; unflagged average is ${delta > 0 ? "+" : ""}${delta.toFixed(1)} stars.`;
    }
    ratingUi.details.textContent = `Included ${ratings.length} rated review(s). Excluded ${excludedCount}: ${flaggedCount} model-flagged, ${unratedCount} without a readable rating, ${failedCount} failed.`;
  }

  function scheduleRescan() {
    if (rescanTimer !== null) window.clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => {
      rescanTimer = null;
      scanReviews(document);
      updateRatingPanelIfOpen();
    }, RESCAN_DELAY_MS);
  }

  const observer = new MutationObserver((mutations) => {
    const hasRelevantAddition = mutations.some((mutation) => {
      if (mutation.target.nodeType === Node.ELEMENT_NODE && mutation.target.closest(`#${RATING_WIDGET_ID}`)) {
        return false;
      }
      return Array.from(mutation.addedNodes).some((node) =>
        !(node.nodeType === Node.ELEMENT_NODE && node.classList.contains(BADGE_CLASS))
      );
    });
    if (hasRelevantAddition) scheduleRescan();
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  createRatingWidget();
  scanReviews(document);
})();
