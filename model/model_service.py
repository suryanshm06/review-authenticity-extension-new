"""Local API for the user's pretrained TF-IDF + XGBoost review detector.

The model artifacts are copied from the linked GitHub repository:
model/fake_review_detector/tfidf.pkl and xgb_model.pkl.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import joblib
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_DIR = Path(__file__).resolve().parent / "fake_review_detector"
VECTORIZER_PATH = MODEL_DIR / "tfidf.pkl"
CLASSIFIER_PATH = MODEL_DIR / "xgb_model.pkl"
MAX_REVIEWS = 50
THRESHOLD = float(os.environ.get("FAKE_REVIEW_THRESHOLD", "0.5"))

app = FastAPI(title="Local Review Classifier", version="1.2.0")
vectorizer: Any | None = None
classifier: Any | None = None

try:
    vectorizer = joblib.load(VECTORIZER_PATH)
    classifier = joblib.load(CLASSIFIER_PATH)
    print(f"Loaded TF-IDF vectorizer from {VECTORIZER_PATH}")
    print(f"Loaded XGBoost classifier from {CLASSIFIER_PATH}")
except FileNotFoundError as error:
    print(f"Model file missing: {error}. Copy tfidf.pkl and xgb_model.pkl into {MODEL_DIR}.")
except Exception as error:
    print(f"Could not load the saved model artifacts: {error}")


class PredictionRequest(BaseModel):
    reviews: list[str]


@app.get("/health")
def health() -> dict[str, bool | str | float]:
    return {
        "ok": True,
        "modelLoaded": vectorizer is not None and classifier is not None,
        "model": "user-repo TF-IDF + XGBoost",
        "threshold": THRESHOLD,
    }


@app.post("/predict")
def predict(request: PredictionRequest) -> dict[str, object]:
    if vectorizer is None or classifier is None:
        raise HTTPException(
            status_code=503,
            detail="The saved TF-IDF/XGBoost files are missing or could not be loaded.",
        )
    if len(request.reviews) > MAX_REVIEWS:
        raise HTTPException(status_code=413, detail=f"A maximum of {MAX_REVIEWS} reviews is allowed.")

    reviews = [review.strip() for review in request.reviews]
    probabilities = classifier.predict_proba(vectorizer.transform(reviews))[:, 1] if reviews else []

    predictions = [
        {
            # In the GitHub training script, class 1 is CG (computer-generated/fake).
            "isFake": bool(float(score) >= THRESHOLD),
            "score": round(float(score), 4),
        }
        for score in probabilities
    ]
    return {
        "predictions": predictions,
        "threshold": THRESHOLD,
        "note": "Class 1 is the repository's CG/fake label; a text score is not proof of deception or AI authorship.",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
