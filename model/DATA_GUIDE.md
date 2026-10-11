# Adding your own labeled examples (beginner guide)

The custom trainer reads `my_labeled_reviews.csv` from this folder. It expects these columns:

```csv
text,ai_label,product_id,source
```

- `text`: the exact review text.
- `ai_label`: `0` for known human-written, `1` for known AI-written. `human`/`AI` also work.
- `product_id`: optional product group, useful for keeping similar examples together.
- `source`: optional note such as `volunteer`, `ChatGPT`, or `Gemini`. This is for your records; it is not a model feature.

The supplied CSV is just a header. Add your own labeled rows; do not add examples merely because they sound AI-like. The label should come from how the text was actually produced.

Example format only (do not treat these sample sentences as useful training data):

```csv
"I used this trimmer for two weeks; the battery lasted about five days.",0,QP2724,volunteer
"This product provides excellent performance and outstanding value for money.",1,QP2724,ChatGPT
```

Save the file as **CSV UTF-8**. If editing with Excel, keep the first row as the column names. Text containing commas should be quoted; Excel normally handles that when saving CSV.

## Where to get examples

### 1. Known human-written examples

Ask real product users or volunteers to write about products they have actually used, with their permission. You can also use a dataset only if its terms allow your intended use and its human/AI labels are meaningful. A “Verified Purchase” tag alone does **not** prove that the text was typed by a human or was not AI-assisted.

### 2. Known AI-written examples

For the same products, use one or more AI tools to generate reviews with varied star ratings, lengths, and prompts. Save the exact outputs, and note the generator in `source`. Avoid copying real reviews into the prompt and asking for a paraphrase; that can cause near-duplicate leakage.

Try to collect examples across multiple products, categories, writing styles, and generators. A few hundred of each class is a useful first experiment; more diverse examples are better. Keep AI-assisted reviews separate or exclude them unless you explicitly want “any AI assistance” to count as AI-written.

### Public starting data

The [OSF Fake Reviews Dataset](https://osf.io/tyue9/) contains 20,000 original/presumed-human reviews and 20,000 computer-generated reviews, and is licensed CC BY 4.0. The generated texts are older GPT-2 examples, so they may not represent modern ChatGPT/Gemini reviews. Your current base dataset is already in a similar generated-vs-original category; downloading another copy alone may not fix modern-model misses.

A 2025 paper also reports a manually labeled collection of 6,217 Amazon reviews, including 1,116 reviews marked AI-generated. Manual AI labels are imperfect, especially for AI-assisted writing; check the paper and data availability before using it: https://www.mdpi.com/2673-4591/92/1/17

## Train with your rows

1. Add your rows to `my_labeled_reviews.csv`.
2. Stop the Python model service with **Ctrl+C**.
3. In Command Prompt with `(.venv)` active, from the project root run:

   ```cmd
   python model\train_model.py
   ```

   Your custom rows are included with extra training weight. The script prints a held-out report and saves a new `model_artifacts\review_classifier.joblib`.
4. Start the Python model service again:

   ```cmd
   python model\model_service.py
   ```

5. Leave the Node bridge running; refresh the product tab.

For a fairer test, keep some products and AI prompts/generators out of training and test on those separately. Randomly splitting near-duplicate reviews can make results look better than real-world performance.

## Important

The existing base dataset combines computer-generated fake reviews with original/presumed-authentic reviews. Adding your examples may help, but this text-only model still cannot prove authorship or dishonesty. “AI-written” and “fake” are different labels; use separate verified labels and models if you need both tasks.
