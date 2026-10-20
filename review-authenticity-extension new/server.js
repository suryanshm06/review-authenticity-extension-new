const express = require("express");
const cors = require("cors");

const app = express();
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
// Keep the bridge local to this machine by default; do not expose it to the LAN.
const HOST = process.env.HOST || "localhost";
const MODEL_API_URL = process.env.MODEL_API_URL || "http://127.0.0.1:8000/predict";
const MAX_REVIEWS_PER_REQUEST = 50;

function isAllowedOrigin(origin) {
  // Requests from curl/Node clients usually do not have an Origin header.
  if (!origin) return true;

  try {
    const { protocol, hostname } = new URL(origin);
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

    if (protocol === "chrome-extension:") return true;
    if (["localhost", "127.0.0.1", "::1"].includes(host)) return true;

    return (
      /(^|\.)amazon\.(in|com)$/i.test(host) ||
      /(^|\.)flipkart\.com$/i.test(host)
    );
  } catch {
    return false;
  }
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by the local CORS policy."));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204
};

app.use((req, res, next) => {
  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
});
app.use(cors(corsOptions));
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "review-authenticity-bridge" });
});

/**
 * Calls the local Python model service and returns its boolean verdicts in order.
 * The selected pretrained model and threshold are configured in model/model_service.py.
 */
async function callMyMLModel(reviews) {
  const response = await fetch(MODEL_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviews })
  });

  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result && (result.detail || result.error)
      ? result.detail || result.error
      : `Model service returned HTTP ${response.status}.`;
    throw new Error(message);
  }

  if (!result || !Array.isArray(result.predictions) || result.predictions.length !== reviews.length) {
    throw new Error("Model service must return one prediction per review.");
  }

  return result.predictions.map((prediction) => {
    if (!prediction || typeof prediction.isFake !== "boolean") {
      throw new Error("Each model prediction must include a boolean isFake value.");
    }
    return prediction.isFake;
  });
}

app.post("/api/detect-fakes", async (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: "Expected a JSON array of review strings." });
  }

  if (req.body.length > MAX_REVIEWS_PER_REQUEST) {
    return res.status(413).json({ error: `A maximum of ${MAX_REVIEWS_PER_REQUEST} reviews is allowed per request.` });
  }

  if (req.body.some((review) => typeof review !== "string")) {
    return res.status(400).json({ error: "Every item in the request array must be a string." });
  }

  const reviews = req.body.map((review) => review.trim());

  try {
    const predictions = await callMyMLModel(reviews);
    return res.json(
      predictions.map((isFake, index) => ({
        reviewId: String(index),
        isFake
      }))
    );
  } catch (error) {
    console.error("Review model inference failed:", error.message || error);
    return res.status(502).json({
      error: "Model inference failed. Check that the Python model service is running and trained."
    });
  }
});

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ error: "Malformed JSON request body." });
  }

  if (error.message === "Origin is not allowed by the local CORS policy.") {
    return res.status(403).json({ error: error.message });
  }

  console.error("Local bridge error:", error);
  return res.status(500).json({ error: "Unexpected local server error." });
});

app.listen(PORT, HOST, () => {
  console.log(`Review authenticity bridge listening at http://${HOST}:${PORT}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
  console.log(`Python classifier expected at ${MODEL_API_URL}`);
});
