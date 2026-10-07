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

## Crop recommendation (to build later)
- Genuine dataset only. 14 target crops: Pearl millet, Wheat, Maize, Onion, Chickpea, Cabbage/Cauliflower, Paddy, Groundnut, Finger millet, Soybean, Sugarcane, Grape, Pomegranate, Tomato.
- Planned sources: Soil Health Card data for Maharashtra (dataful.in), ICAR District Agricultural Contingency Plan for Nashik, MPKV Agromet bulletins. Verify availability first.

## Git and safety rules
- Work on the branch `integration`. Never push to `main` or to a remote without asking Shubham.
- Never print, log, commit or paste API keys. `.env`, `venv/` and `disease_api/model/` stay out of git.
- Do not delete or rewrite existing features. Keep Aditya's code style.
- Do not start long-running servers yourself. Tell Shubham the command and let him run each server in its own terminal.

## Run everything (three terminals)
1. `cd backend` then `start.bat` (port 8000)
2. `cd disease_api` then `python app.py` (port 5002)
3. `npx serve frontend` or `python -m http.server 3000 --directory frontend` (port 3000), open http://localhost:3000 in Chrome or Edge

## Still needed for the report
- Sources and licences of the maize, onion and cotton datasets; expert check of Iris yellow virus labels; a real-world photo test; update slides to say Nashik district; pomegranate as future work.
