"""Train a local, experimental generated-review text classifier.

The bundled Hugging Face source labels computer-generated fake reviews as 1
and original/presumed-authentic reviews as 0. Optional user-labeled examples
can be added to model/my_labeled_reviews.csv; those use 1 = AI-written and
0 = human-written. These labels are related but are not proof of deception.
"""
from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path

import joblib
from datasets import load_dataset
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline

DATASET_ID = "theArijitDas/Fake-Reviews-Dataset"
MODEL_DIR = Path(__file__).resolve().parent / "model_artifacts"
MODEL_PATH = MODEL_DIR / "review_classifier.joblib"
CUSTOM_CSV_PATH = Path(__file__).resolve().parent / "my_labeled_reviews.csv"
FLAG_THRESHOLD = 0.85
CUSTOM_SAMPLE_WEIGHT = 20.0
RANDOM_STATE = 42


def normalize_label(raw_label: object, row_number: int) -> int:
    value = str(raw_label or "").strip().lower().replace("_", "-")
    if value in {"0", "human", "human-written", "original", "or"}:
        return 0
    if value in {"1", "ai", "ai-written", "ai-generated", "computer-generated", "cg"}:
        return 1
    raise ValueError(
        f"Row {row_number} in {CUSTOM_CSV_PATH.name} has label {raw_label!r}. "
        "Use 0 for human-written or 1 for AI-written."
    )


def load_custom_examples() -> list[tuple[str, int]]:
    if not CUSTOM_CSV_PATH.exists():
        return []

    with CUSTOM_CSV_PATH.open("r", encoding="utf-8-sig", newline="") as csv_file:
        reader = csv.DictReader(csv_file)
        fieldnames = set(reader.fieldnames or [])
        if "text" not in fieldnames:
            raise ValueError(f"{CUSTOM_CSV_PATH.name} must have a 'text' column.")
        label_column = "ai_label" if "ai_label" in fieldnames else "label" if "label" in fieldnames else None
        if label_column is None:
            raise ValueError(f"{CUSTOM_CSV_PATH.name} needs an 'ai_label' (or 'label') column.")

        examples: list[tuple[str, int]] = []
        for row_number, row in enumerate(reader, start=2):
            text = str(row.get("text") or "").strip()
            if not text:
                continue
            label = normalize_label(row.get(label_column), row_number)
            examples.append((text, label))

    return examples


def main() -> None:
    print(f"Downloading/loading base dataset: {DATASET_ID}")
    rows = load_dataset(DATASET_ID, split="train")

    # Keep track of all labels for each exact text. Conflicting labels for
    # identical text are removed instead of teaching contradictory examples.
    labels_by_text: dict[str, set[int]] = defaultdict(set)
    custom_texts: set[str] = set()

    for row in rows:
        text = str(row.get("text", "")).strip()
        if not text:
            continue
        labels_by_text[text].add(int(row["label"]))

    custom_examples = load_custom_examples()
    for text, label in custom_examples:
        labels_by_text[text].add(label)
        custom_texts.add(text)

    examples = [
        (text, next(iter(labels)), CUSTOM_SAMPLE_WEIGHT if text in custom_texts else 1.0)
        for text, labels in labels_by_text.items()
        if len(labels) == 1
    ]
    if len(examples) < 100:
        raise RuntimeError(f"Only {len(examples)} usable examples loaded; check the dataset download and schema.")

    texts = [text for text, _label, _weight in examples]
    labels = [label for _text, label, _weight in examples]
    sample_weights = [weight for _text, _label, weight in examples]
    if set(labels) != {0, 1}:
        raise RuntimeError(f"Expected binary labels 0 and 1, found: {sorted(set(labels))}")

    print(f"Using {len(texts):,} unique, non-conflicting reviews.")
    print(f"Loaded {len(custom_examples):,} rows from {CUSTOM_CSV_PATH.name} (custom examples receive weight {CUSTOM_SAMPLE_WEIGHT:g}).")
    print("Base label 0 = original/presumed-authentic; base label 1 = computer-generated fake.")
    print("Custom label 0 = human-written; custom label 1 = AI-written.")

    x_train, x_test, y_train, y_test, weights_train, _weights_test = train_test_split(
        texts,
        labels,
        sample_weights,
        test_size=0.20,
        random_state=RANDOM_STATE,
        stratify=labels,
    )

    pipeline = Pipeline(
        steps=[
            (
                "tfidf",
                TfidfVectorizer(
                    lowercase=True,
                    strip_accents="unicode",
                    ngram_range=(1, 2),
                    min_df=2,
                    max_features=100_000,
                    sublinear_tf=True,
                ),
            ),
            (
                "classifier",
                LogisticRegression(
                    max_iter=500,
                    class_weight="balanced",
                    random_state=RANDOM_STATE,
                ),
            ),
        ]
    )

    print("Training TF-IDF + Logistic Regression. This may take a few minutes...")
    pipeline.fit(x_train, y_train, classifier__sample_weight=weights_train)

    probabilities = pipeline.predict_proba(x_test)[:, 1]
    predicted = [int(score >= FLAG_THRESHOLD) for score in probabilities]
    print(f"\nHeld-out report at threshold {FLAG_THRESHOLD:.2f}:")
    print(classification_report(y_test, predicted, target_names=["original/presumed authentic", "computer-generated/AI-like"]))
    print("Confusion matrix (rows=actual, columns=predicted):")
    print(confusion_matrix(y_test, predicted))

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "pipeline": pipeline,
            "threshold": FLAG_THRESHOLD,
            "dataset_id": DATASET_ID,
            "custom_csv": str(CUSTOM_CSV_PATH),
            "custom_examples_count": len(custom_examples),
            "positive_label": "computer-generated/AI-like (experimental combined label)",
        },
        MODEL_PATH,
    )
    print(f"\nSaved model to: {MODEL_PATH}")
    print("The holdout score is only a dataset check. Keep products/prompts separated between train and test when possible.")
    print("Text-only predictions are experimental and do not prove AI authorship or dishonesty.")


if __name__ == "__main__":
    main()
