# Review Authenticity Highlighter

A local Chrome/Brave extension for Amazon.in, Amazon.com, and Flipkart. It sends review text to a local Express bridge and a local Python service, highlights reviews the supplied TF-IDF + XGBoost model flags, and can calculate an average star rating from analyzed reviews the model did not flag.

## Important model limitations

The supplied GitHub model uses `OR = 0` (original/presumed-genuine) and `CG = 1` (computer-generated/fake). Its class-1 probability is treated as a suspicion score; reviews at or above `0.50` are flagged. A model-unflagged review is **not verified** as human-written or genuine, and a flagged review is not proof of deception or AI authorship. Treat both the badge and adjusted rating as decision aids, not facts.

The model expects review text prefixed with a rating when one is available (for example, `5 stars. Review text`). The extension tries to extract star ratings from each supported site's review markup. Missing or unreadable ratings are omitted from the average.

## Project files

- `manifest.json` — Manifest V3 extension settings and local API permission.
- `content.js` — review extraction, dynamic page observation, model results, badge, and adjusted-rating UI.
- `styles.css` — red warning highlight and bottom-right rating panel.
- `background.js` — extension service worker that requests the local Node bridge.
- `server.js` — local Express/CORS bridge on port 3000.
- `model/model_service.py` — local Python API on port 8000; loads the included saved artifacts.
- `model/fake_review_detector/tfidf.pkl` and `xgb_model.pkl` — pretrained model files from the repository supplied by the user.
- `model/requirements.txt` — Python dependencies.

No training run is required. Do not run a separate baseline trainer; the bundled GitHub artifacts are the model used for inference.

## Requirements

- Windows 10 or newer.
- Python 3.10 or newer. If the `py` launcher is unavailable, use `python` commands as shown below.
- Node.js 18 or newer.
- Chrome or a Chromium-based browser such as Brave.

## First-time setup on Windows

Extract the complete project folder somewhere convenient. Open Command Prompt and change directory to the folder containing `manifest.json` and `package.json`. For example:

```cmd
cd /d "C:\Users\admin\Downloads\project norman\review-authenticity-extension new"
```

### 1. Create a Python environment and install dependencies

Run these once in that project folder:

```cmd
python --version
python -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install --upgrade -r model\requirements.txt
```

The saved TF-IDF vectorizer was serialized with scikit-learn 1.9.0; the requirements pin that version for compatibility. If `python` is not recognized, install Python from python.org, select **Add python.exe to PATH**, then reopen Command Prompt.

### 2. Install Node dependencies

In the same project folder, run:

```cmd
npm install
```

This is a one-time setup for this folder.

### 3. Start the Python model service

In the first Command Prompt, with `(.venv)` active, run:

```cmd
python model\model_service.py
```

Leave the window open. Check `http://127.0.0.1:8000/health`; the JSON should report `"modelLoaded": true`. A `404` at the root `http://127.0.0.1:8000/` is expected; use `/health`.

### 4. Start the Node bridge

Open a second Command Prompt in the project folder and run:

```cmd
npm start
```

Leave this window open too. Check `http://localhost:3000/health`; it should report `"ok": true`.

### 5. Load the extension

1. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the project folder containing `manifest.json` (not the ZIP and not the `model` subfolder).
4. Make sure the extension is enabled.

## Use the extension

1. Keep both service windows running.
2. Open a product page on Amazon.in, Amazon.com, or Flipkart.
3. Refresh the page and scroll so reviews load. The extension analyzes review batches as they appear.
4. Reviews the model flags receive a red border and the badge `⚠️ AI flagged as likely fake.`
5. To request the adjusted rating, click **Show adjusted rating** at the bottom-right of the page. The panel shows the arithmetic mean of readable star ratings on analyzed reviews that the model did not flag.
6. Scroll to load more reviews, allow the analysis to finish, then click **Recalculate** to include the newly loaded reviews.

The adjusted rating only covers reviews that are currently loaded on the page, have a readable star rating, and have a completed model verdict. Model-unflagged does not mean confirmed genuine.

## Quick troubleshooting

- Python health: `http://127.0.0.1:8000/health` → `modelLoaded` should be `true`.
- Node health: `http://localhost:3000/health` → `ok` should be `true`.
- After reloading the extension in `chrome://extensions` or `brave://extensions`, refresh the product tab.
- On the product page, DevTools Console checks:

  ```js
  document.querySelectorAll('[data-ml-status="complete"]').length
  document.querySelectorAll('[data-ml-status="error"]').length
  document.querySelectorAll('[data-ml-fake="true"]').length
  ```

  Completed reviews with no errors means the pipeline is working, even if no review is flagged.
- Amazon advertising/CSP console messages are from Amazon, not necessarily the extension. Look for messages beginning `[Review Highlighter]` for extension errors.
- Keep the services bound to the local computer. Do not expose them to the internet or LAN.

## Stop the services

When finished, press **Ctrl+C** in each service Command Prompt. Next time, activate `.venv` and start the Python service again, then run `npm start` in a second window. No retraining is needed.
