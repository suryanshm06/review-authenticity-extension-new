# Review Authenticity Highlighter — GitHub XGBoost model update

This is an update for the existing Manifest V3 Chrome extension. It switches the Python API from the earlier experimental Logistic Regression baseline to the pretrained TF-IDF + XGBoost files from the GitHub repository you provided. **It does not retrain the model.**

The browser extension still watches Amazon.in, Amazon.com, and Flipkart review sections, submits small batches of review strings to the local Express bridge, and highlights flagged reviews in red.

## What the model means (important)

The repository's training code uses `OR = 0` for original/presumed-genuine reviews and `CG = 1` for computer-generated/fake reviews. The service treats the class-1 probability as the score and flags a review at `0.50` or above, matching the repository's inference wrapper.

A flag is only a match to patterns learned from that model's dataset. It does **not** prove that a review is fake, dishonest, or AI-written, and it may make mistakes. The requested badge wording is `⚠️ AI flagged as likely fake.`; interpret it as a warning to check the review, not as proof.

The GitHub model was trained with text in the form `5 stars. review text`. The extension now tries to extract the rating on Amazon and Flipkart and prefixes it in that format. If a rating cannot be found, it sends the review text without a prefix. The API still receives a plain JSON array of strings.

## Files in this update

- `content.js` — rating extraction, dynamic review observation, batching, and the exact requested badge wording.
- `model/model_service.py` — loads the bundled TF-IDF and XGBoost artifacts and returns class-1 scores.
- `model/requirements.txt` — includes the XGBoost dependency.
- `model/fake_review_detector/tfidf.pkl` and `xgb_model.pkl` — saved artifacts from your linked repository.
- `server.js` — no API behavior change; its explanatory comment now points at the active model service.

The existing `manifest.json`, `background.js`, `styles.css`, and `package.json` are unchanged. `server.js` still has the same API behavior; its comment now points to the selected model service. The old `model/train_model.py`, `model/my_labeled_reviews.csv`, and `model/model_artifacts/review_classifier.joblib` (if present) are not used by this model service. **Do not run the old trainer for this setup**; it creates a separate Logistic Regression model and does not replace these GitHub artifacts.

## Apply this update to your existing Windows project

The ZIP is an **update patch**, not a complete project. Extract it first, then copy its files into your existing extension folder while preserving the folder structure. For example, copy the patch's `content.js` into the project root and its `model` folder into the project's `model` folder. Allow Windows to replace the matching `content.js`, `model_service.py`, `requirements.txt`, and model artifact files. Do not delete your other project files.

### 1. Stop the Python service

In the Command Prompt window running the Python service, press **Ctrl+C**. If the Node bridge is already working, it can stay open; otherwise start it as described below.

### 2. Install the XGBoost dependency

Open a new Command Prompt in the existing project folder (the folder containing `package.json`). Activate the project's virtual environment, then install the updated requirements:

```cmd
.venv\Scripts\activate
python -m pip install --upgrade -r model\requirements.txt
```

This upgrades older packages in the virtual environment; the saved TF-IDF vectorizer was serialized with scikit-learn 1.9.0, so keep the environment updated. If Command Prompt says the activation file does not exist, create the environment once with `py -m venv .venv`, then activate it and run the install command again.

### 3. Start the Python model service

In that Command Prompt, run:

```cmd
python model\model_service.py
```

Leave the window open. In Chrome, visit `http://127.0.0.1:8000/health`. Confirm that the page says `"modelLoaded": true` and identifies `user-repo TF-IDF + XGBoost`.

### 4. Start or keep the Node bridge running

If the bridge is not already running, open a second Command Prompt in the project folder and run:

```cmd
npm install
npm start
```

Leave that window open. Check `http://localhost:3000/health`; it should say `"ok": true`.

### 5. Reload the Chrome extension

1. Open `chrome://extensions`.
2. Find **Review Authenticity Highlighter** and click **Reload**. If it is not listed, turn on **Developer mode**, click **Load unpacked**, and choose your existing project folder (the one containing `manifest.json`), not the extracted patch folder.
3. Refresh the Amazon or Flipkart product page and scroll to its reviews.

The extension's MV3 service worker makes the request to the local bridge. Keep the Python service and Node bridge running while using the extension.

## Quick checks and troubleshooting

- Python model health: `http://127.0.0.1:8000/health` → `modelLoaded` must be `true`.
- Node bridge health: `http://localhost:3000/health` → `ok` must be `true`.
- If health reports the model is not loaded, check that both files exist under `model\fake_review_detector\` and that `xgboost` installed successfully.
- If the extension makes no request, reload it in `chrome://extensions`, refresh the product tab, and check the tab's Developer Tools Console for `[Review Highlighter]` messages.
- If no reviews are highlighted, the model may have scored them below `0.50`, or the site may have changed its review markup. Review selectors are grouped near the top of `content.js` and are best-effort.
- Keep the services bound to this computer only. Do not expose the local bridge or Python service to the internet or your LAN.

## Security note

The `.pkl` artifacts use Python pickle serialization. Loading pickle files can execute code, so use only model artifacts from a repository you trust. These bundled artifacts were taken from the repository you supplied.
