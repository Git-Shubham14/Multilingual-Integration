# PID-14: AI-powered multilingual agricultural assistant (Nashik district)

Final-year B.Tech IT project, K. K. Wagh Institute of Engineering Education & Research, Nashik.
Guide: Prof. Reena Johnson. Owner: Shubham (beginner coder).

## How to work with Shubham
- Two-way. Before changing files, show a short plan (files and why) and wait for his OK.
- Beginner level: plain words, exact file paths, full commands, comments in the code.
- Small steps. After each working step, explain how to test it, and make one git commit.
- Everything must be free: free tiers or open source only. Check current free limits before relying on a service.
- Never use AI-generated data for training or evaluation.
- Be honest when something is untested or weaker than it looks.

## Scope (set by the guide)
Nashik district only. English, Hindi, Marathi. Text and voice. One app with three abilities:
1. Farming Q&A in the farmer's language, answer spoken back (Aditya's module, working).
2. Plant disease detection from a leaf photo (built, runs as a separate API).
3. Crop recommendation for Nashik (NOT built yet; needs a genuine dataset).
Fast response is a key requirement.

## Repository layout (this folder is Aditya's repo, cloned)
- `backend/`  FastAPI server (port 8000): speech-to-text, translation, LLM chat, text-to-speech, SQLite chat history. Keys in `backend/.env` (never commit, never print).
- `frontend/` plain JavaScript web app (PWA), served on port 3000.
- `disease_api/` Shubham's Flask disease API (port 5002). It has its own Python packages (torch). Do NOT install torch into the backend's venv.
  - `disease_api/model/` holds `best_model.pt` and `model_meta.json`. It is git-ignored (large file).

How the parts connect:
```
Browser (frontend) -> backend :8000 -> disease_api :5002   (photo + crop in, JSON out)
                                    -> crop API (to build)
```
The frontend never calls port 5002 directly. The backend forwards the request.

## Disease API contract (do not change the model or its logic)
- `POST http://127.0.0.1:5002/predict-disease`, multipart form: `image` (file, JPG/PNG, max 10 MB), `crop` (one of Cotton, Grape, Maize, Onion, Tomato; case-insensitive).
- Success (HTTP 200):
```json
{"crop": "Onion", "status": "ok", "message": "The most likely problem is Purple Blotch.",
 "note": "Some viral and root diseases cannot always be confirmed ... KVK).", "precautions": [], "threshold": 0.7,
 "top": [{"class": "Onion___Purple_Blotch", "disease": "Purple Blotch", "is_healthy": false, "probability": 0.9892},
         {"class": "Onion___Alternaria", "disease": "Alternaria", "is_healthy": false, "probability": 0.004}]}
```
- `status` is `"ok"` or `"not_sure"` (top probability below 0.7). Healthy leaves have `is_healthy: true`.
- Errors: HTTP 400 or 413 with `{"error": "...", "supported_crops": [...]}`.
- `GET /crops` lists every crop with its diseases. `GET /health` checks the service.
- The API answers in English only. Do NOT machine-translate its `message`. Build the farmer's message from the structured fields (`status`, `top[0].disease`, `top[1]`, `is_healthy`) using fixed templates per language and a checked table of disease names (`backend/data/disease_names.json`). Machine translation only as a marked fallback. A wrong disease name could mislead a farmer.

## Disease model facts
- ResNet18, 27 classes, 5 crops, farmer picks the crop first. Test accuracy 97.3% (95.3% on the half least similar to training photos).
- Known limits (say them in the report): photos are lab-style or plain-background, real farm photos are untested; near-duplicate photos exist inside the source datasets; Iris yellow virus labels are unchecked; no pomegranate data.
- Weak classes: Maize Gray Leaf Spot vs Blight, Onion Alternaria vs Fusarium, Onion Iris Yellow Virus vs Healthy.

## Multilingual module (Aditya's; verified against the code 2026-10-07)
- Default mode (`INFERENCE_MODE=api` in `.env`, the out-of-the-box setting): speech-to-text is
  Google's free speech API (`backend/models/asr.py`, hardcoded to Marathi only — no Hindi/English
  input, no auto-detect); translation is Google Translate/MyMemory (`backend/models/translation.py`);
  text-to-speech is gTTS (`backend/models/tts.py`). The AI4Bharat/IndicTrans2/Indic Parler-TTS models
  the README describes only run if `.env` sets `INFERENCE_MODE=local`, which is untested end-to-end.
- LLM chat is NVIDIA Nemotron (free key), called from `backend/main.py`. The system prompt is the
  `FARMER_SYSTEM_PROMPT` constant there (~line 61); it already asks for short answers and points to
  the local KVK for serious problems, but does not yet forbid giving pesticide doses/quantities
  (tightening this is Step C, tracked separately).
- There is no language selector in the frontend yet — `reply_language` is hardcoded to `"mr"` in
  `frontend/app.js`. The backend already accepts `mr, hi, en, gu, kn, te, ta, bn, pa` for LLM replies.
- Needs `HF_TOKEN` and `NVIDIA_API_KEY` in `backend/.env`. Free tiers can be rate-limited or queued.
- Still to check: end-to-end speed (not yet measured); local-mode AI4Bharat pipeline.

## Module 2 – Crop Recommendation (status)
- `crop_api/` (Flask, port 5003): rule-based recommendations from the ICAR Nashik 2011
  District Agricultural Contingency Plan (15 crops, 7 verified so far), filtered by
  soil type (light/medium/heavy) and season window; weather + dry-spell check from the
  free Open-Meteo API; BM25 retrieval (RAG) over chunks of the ICAR PDF for the
  explanation text, with pesticide-dose pages deliberately excluded from the chunk set.
- `backend` `/api/crop` and `/api/crop/options`: ask Nemotron (Super model first, Ultra
  as backup, 10 s time limit) to turn the rule output into a short explanation, then run
  it through a validator that rejects unknown crop ids, pesticide doses/quantities,
  pesticide-related words, wrong-language output, or a `risk` field that just repeats
  `reason`. Marathi has an extra word-fix list for common mistranslations. If Nemotron
  fails or is rejected, the API falls back to the plain rules output (no LLM text).
- `frontend`: new "🌾 Crop Advisor" form and result card, with mr/hi/en labels from a
  `CropI18n` table. Tap the 🔊 icon to hear the result via the existing TTS pipeline.
  `sw.js` cache bumped to v7 so the PWA picks up the new screen.
- Run order (4 terminals now): `crop_api` (port 5003) and `disease_api` (port 5002) first,
  then `backend` (`start.bat`, port 8000), then `frontend` (port 3000). Restart `crop_api`
  and `backend` after editing their code — neither auto-reloads.
- Next planned: try Sarvam AI's `sarvam-105b` model for Marathi/Hindi crop explanations
  and chat answers, with Nemotron kept as the fallback, plus a daily request cap once
  that's wired in. Still genuine-dataset-only for the underlying rules; still never
  commit `backend/.env`.
- Original target list for a future, fuller dataset-based version (not yet reached): 14
  crops — Pearl millet, Wheat, Maize, Onion, Chickpea, Cabbage/Cauliflower, Paddy,
  Groundnut, Finger millet, Soybean, Sugarcane, Grape, Pomegranate, Tomato. Planned
  sources: Soil Health Card data for Maharashtra (dataful.in), MPKV Agromet bulletins.
  Verify availability first.

## Crop LLM provider (Sarvam, added 2026-10-19)
- `/api/crop` now tries Sarvam's `sarvam-105b` first for mr/hi (`backend/models/sarvam_client.py`),
  with a strict JSON schema (one `{id, reason, risk}` per crop, ids restricted to that
  request's crop_api recommendations) and `reasoning_effort` always `None` (sarvam-105b
  otherwise "thinks" and returns an empty answer). Fallback chain: Sarvam -> Nemotron ->
  rules text. English always goes straight to Nemotron (`pick_provider()` in `backend/main.py`).
- Whole mr/hi chain capped at 12 s total: Sarvam gets up to 6 s, Nemotron then gets
  whatever's left, never less than 3 s. Daily request cap 300, counted in
  `backend/data/sarvam_usage.json` (git-ignored, resets at IST midnight). Every fallback
  is logged with its reason (timeout / bad JSON / cap reached / HTTP error + status / not
  configured).
- `backend/tests/conftest.py` disables `SARVAM_API_KEY` and redirects the usage-counter file
  for every backend test, so running the test suite never burns real Sarvam quota even
  though `backend/.env` has a real key for the comparison scripts below.
- Comparison scripts (`backend/scripts/compare_pipelines.py`, `compare_chat_b2.py`,
  `debug_crop_c.py`, `check_sarvam.py`) tried pipeline A (Nemotron direct), B (translate
  round-trip), C (Sarvam direct), and B2 (Nemotron answers in English, Sarvam rewrites to
  mr/hi). Result: chat's best pipeline is B2, but that is **not yet wired into `/api/chat`**
  (still Nemotron-only `CHAT_MODE=direct`); crop's and disease's best pipeline is C (Sarvam
  direct). Crop is wired in as above; disease still only uses the fixed-template
  `/api/disease` route (never freeform LLM text, per the disease-names rule above) -- the
  disease result is for the report, not yet implemented.

## Chat LLM provider (pipeline B2, added 2026-10-20)
- `/api/chat` is still single-turn: no chat history is sent to the LLM (the SQLite
  history in `backend/models/db.py` is only for the sidebar UI). Both text chat and
  voice chat call the same endpoint; neither streams -- one JSON response per request.
- For mr/hi (en is untouched, always straight to Nemotron): Nemotron first answers the
  farmer's original mr/hi question in English, then sarvam-105b rewrites that English
  answer into natural mr/hi (`_chat_pipeline_b2` in `backend/main.py`). Controlled by
  `CHAT_LLM_PROVIDER` ("b2" default, or "nemotron" to switch this off entirely and keep
  today's plain Nemotron-direct mr/hi behaviour, `_chat_direct`, as before this phase).
- Fallback order: Nemotron slow/fails -> pipeline C (sarvam-105b answers mr/hi directly)
  -> if the rewrite fails validation and budget remains, also try pipeline C -> if both
  b2 and C fail, a short fixed "couldn't answer, try again" message from
  `backend/data/chat_messages.json` (reviewed:false) -- NOT a second call to
  `_chat_direct`, since Nemotron likely just failed/is slow and retrying it would only
  make the farmer wait longer for the same outcome.
- Whole chain (Nemotron English answer + sarvam rewrite, or the pipeline C fallback) is
  capped at `CHAT_TOTAL_TIMEOUT_S` (14s) total; `CHAT_NEMOTRON_TIMEOUT_S` (8s) and
  `CHAT_REWRITE_TIMEOUT_S` (4s) cap their own steps, never letting the chain run over.
- Validation on the final mr/hi text reuses crop/disease's existing wrong-language check
  and `mr_word_fixes.json`. `response_en` in the API response is only ever real English
  on the b2 path; it's empty on pipeline C and the fixed-message fallback (no English
  text exists there, so it's never filled with mr/hi under an "_en" name).
- Sarvam calls share the same daily cap/usage file as crop/disease (`sarvam_usage.json`).
- Tested in `backend/scripts/compare_chat_b2.py` before building this; see
  `backend/tests/test_chat_provider.py` for the mocked fallback-chain tests.

## Git and safety rules
- Work on the branch `integration`. Never push to `main` or to a remote without asking Shubham.
- Never print, log, commit or paste API keys. `.env`, `venv/` and `disease_api/model/` stay out of git.
- Do not delete or rewrite existing features. Keep Aditya's code style.
- Do not start long-running servers yourself. Tell Shubham the command and let him run each server in its own terminal.

## Run everything (four terminals)
1. `cd crop_api` then `python app.py` (port 5003)
2. `cd disease_api` then `python app.py` (port 5002)
3. `cd backend` then `start.bat` (port 8000)
4. `npx serve frontend` or `python -m http.server 3000 --directory frontend` (port 3000), open http://localhost:3000 in Chrome or Edge

## Still needed for the report
- Sources and licences of the maize, onion and cotton datasets; expert check of Iris yellow virus labels; a real-world photo test; update slides to say Nashik district; pomegranate as future work.
