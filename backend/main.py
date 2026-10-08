"""
main.py — FastAPI Backend
Marathi-English Speech Translator PWA

Routes:
  POST /api/speech-to-text   Audio → Marathi text + English translation
  POST /api/text-to-speech   English text → Marathi audio + word timings
  POST /api/disease          Leaf photo + crop → disease_api (port 5002), translated to a farmer message
  GET  /api/health           Health check
"""

import os
import json
import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from openai import AsyncOpenAI

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Bypass WDAC blocking sklearn DLLs (sparsefuncs_fast.pyd)
import sys
from unittest.mock import MagicMock
sys.modules['sklearn.utils.sparsefuncs_fast'] = MagicMock()

# Import model modules
from models.asr import transcribe_marathi
from models.translation import translate, translate_marathi_to_english, translate_english_to_marathi
from models.tts import synthesize_marathi_speech
from models.db import init_db, create_chat, get_chats, get_chat_messages, add_message, delete_chat
from utils.text_cleaner import clean_for_translation

# ─── LLM Config ───────────────────────────────────────────────────────────────

# Third-party models on NVIDIA's free tier (DeepSeek, Gemma, GLM, Kimi) are
# often queued for minutes; NVIDIA's own Nemotron models respond in seconds.
LLM_MODEL = os.getenv("LLM_MODEL", "nvidia/nemotron-3-ultra-550b-a55b")
LLM_FALLBACK_MODEL = os.getenv("LLM_FALLBACK_MODEL", "nvidia/nemotron-3-super-120b-a12b")
LLM_HEDGE_AFTER = float(os.getenv("LLM_HEDGE_AFTER", "8"))
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "40"))
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "600"))

# ─── Disease detection (forwards to Shubham's separate Flask service) ─────────

DISEASE_API_URL = os.getenv("DISEASE_API_URL", "http://127.0.0.1:5002")
DISEASE_NAMES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "disease_names.json")

_disease_names: Optional[dict] = None


def _load_disease_names() -> dict:
    """Load backend/data/disease_names.json once and cache it in memory."""
    global _disease_names
    if _disease_names is None:
        with open(DISEASE_NAMES_PATH, encoding="utf-8") as f:
            _disease_names = json.load(f)
    return _disease_names


def _disease_label(class_name: str, language: str) -> str:
    """Checked name for one of disease_api's 27 classes, e.g. 'Onion___Purple_Blotch'."""
    entry = _load_disease_names()["diseases"].get(class_name, {})
    if language != "en":
        lang_entry = entry.get(language)
        if lang_entry:
            return lang_entry["name"]
    return entry.get("en") or class_name.split("___", 1)[-1].replace("_", " ")


def _crop_label(crop: str, language: str) -> str:
    entry = _load_disease_names()["crops"].get(crop, {})
    if language != "en":
        lang_entry = entry.get(language)
        if lang_entry:
            return lang_entry["name"]
    return entry.get("en") or crop


def _disease_plural(class_name: str, language: str) -> bool:
    """Whether this class's name in this language is a plural noun (default False)."""
    if language == "en":
        return False
    entry = _load_disease_names()["diseases"].get(class_name, {})
    lang_entry = entry.get(language)
    return bool(lang_entry and lang_entry.get("plural", False))


def _build_disease_message(result: dict, language: str) -> str:
    """
    Build the farmer-facing message from disease_api's structured fields
    (status, top[0], top[1], is_healthy) using the checked name table and
    fixed templates — never by machine-translating disease_api's English
    `message`, since a wrong disease name could mislead a farmer (CLAUDE.md).

    The KVK note is a fixed, pre-translated sentence per language, appended
    whenever disease_api sends a non-empty `note` — disease_api currently
    only ever sends one note (for Onion), so this is keyed on presence, not
    on the note's actual English text. If disease_api starts sending other
    crop-specific notes with different meanings, this will need a real
    per-note translation table instead of one fixed sentence.
    """
    templates = _load_disease_names()["templates"][language]
    top = result["top"]
    best = top[0]

    if result["status"] == "not_sure":
        return templates["not_sure"]

    crop_label = _crop_label(result["crop"], language)
    if best["is_healthy"]:
        message = templates["healthy"].format(crop=crop_label)
    else:
        disease_label = _disease_label(best["class"], language)
        fmt_kwargs = {"crop": crop_label, "disease": disease_label}
        if "copula_singular" in templates:
            plural = _disease_plural(best["class"], language)
            fmt_kwargs["copula"] = templates["copula_plural"] if plural else templates["copula_singular"]

        if len(top) > 1 and top[1]["probability"] >= 0.25:
            second = templates["healthy_word"] if top[1]["is_healthy"] else _disease_label(top[1]["class"], language)
            message = templates["disease_two"].format(**fmt_kwargs, second=second)
        else:
            message = templates["disease_one"].format(**fmt_kwargs)

    if result.get("note"):
        message += " " + templates["kvk_note"]
    return message

FARMER_SYSTEM_PROMPT = (
    "You are Krishi Mitra, an agricultural advisor for small farmers in India. "
    "Always reply in {language} using simple, everyday words a farmer understands. "
    "Keep answers short: at most 4 sentences, plain words, practical and "
    "actionable. Never name a specific pesticide, fungicide, or fertilizer "
    "brand, and never give a dose, quantity, or mixing ratio — these vary by "
    "product and a wrong amount can harm the crop or the farmer. Instead "
    "tell the farmer to follow the instructions on the product label and to "
    "contact the local Krishi Vigyan Kendra (KVK) or agriculture extension "
    "officer for the right product and dose. Where useful, mention "
    "non-chemical steps first: removing and destroying infected leaves, "
    "proper plant spacing, and good drainage. Your reply will be read aloud "
    "by a text-to-speech engine, so write plain sentences only: no markdown, "
    "no bullet points or symbols like - or *, no headings, no emojis, no tables."
)

ORIGINAL_LANGUAGE_LABELS = {"mr": "Marathi", "hi": "Hindi"}

# ─── Farm glossary (fixed mr/hi terms, see CLAUDE.md on disease names) ────────

FARM_GLOSSARY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "farm_glossary.json")
_farm_glossary: Optional[dict] = None
_glossary_word_cache: dict[tuple[str, str], str] = {}

# Standard \w doesn't count Devanagari vowel signs/matras as word characters,
# so a plain \bword\b would wrongly match inside a longer word (e.g. "पान"
# inside "पानांची"). This class treats the whole Devanagari block as "word".
_DEVANAGARI_WORD_CHAR = r"[\wऀ-ॿ]"


def _load_farm_glossary() -> dict:
    """Load backend/data/farm_glossary.json once and cache it in memory."""
    global _farm_glossary
    if _farm_glossary is None:
        with open(FARM_GLOSSARY_PATH, encoding="utf-8") as f:
            _farm_glossary = json.load(f)
    return _farm_glossary


def _whole_word_present(word: str, text: str) -> bool:
    """True if `word` is in `text` as a separate word, not as a substring of
    a longer word."""
    pattern = rf"(?<!{_DEVANAGARI_WORD_CHAR}){re.escape(word)}(?!{_DEVANAGARI_WORD_CHAR})"
    return re.search(pattern, text) is not None


def _translated_glossary_word(term: str, language: str) -> Optional[str]:
    """Read-only cache lookup. The cache is filled once at server startup by
    _prefill_glossary_cache() — never during a request, so a slow or failing
    translation call can't add latency or risk to /api/chat."""
    return _glossary_word_cache.get((term, language))


async def _prefill_glossary_cache():
    """Fill _glossary_word_cache in the background after startup, one
    glossary term every 0.5s via Google Translate only (google_only=True —
    no MyMemory fallback here). A failed lookup is simply left out of the
    cache; _apply_farm_glossary then skips that term instead of retrying
    mid-request."""
    glossary = _load_farm_glossary()
    for language, terms in glossary.items():
        for term in terms:
            try:
                word = (await translate(term, "en", language, google_only=True)).strip().rstrip(".।")
                if word:
                    _glossary_word_cache[(term, language)] = word
                    logger.info("Glossary cache: %s/%s -> %s", term, language, word)
            except Exception as e:
                logger.warning("Glossary cache: %s/%s failed (%s); term will be skipped", term, language, e)
            await asyncio.sleep(0.5)


async def _apply_farm_glossary(translated_text: str, english_text: str, language: str) -> str:
    """
    Swap the general-purpose translator's wording for our fixed farm terms.

    For every English glossary term that appears in the LLM's English answer,
    translate that single word into `language` and see what word the
    translator chose. If it differs from our fixed glossary word, replace it
    in the translated text (whole-word only, so it can't corrupt a longer
    word that happens to contain the same letters).
    """
    terms = _load_farm_glossary().get(language)
    if not terms:
        return translated_text

    result = translated_text
    english_lower = english_text.lower()
    for term, fixed_word in terms.items():
        if not fixed_word or _whole_word_present(fixed_word, result):
            continue
        if not re.search(rf"\b{re.escape(term)}s?\b", english_lower):
            continue
        translator_word = _translated_glossary_word(term, language)
        if translator_word is None:
            continue
        if translator_word and translator_word != fixed_word:
            pattern = rf"(?<!{_DEVANAGARI_WORD_CHAR}){re.escape(translator_word)}(?!{_DEVANAGARI_WORD_CHAR})"
            result = re.sub(pattern, fixed_word, result)
    return result

_llm_client: Optional[AsyncOpenAI] = None

# ─── App Setup ────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    logger.info("🚀 Marathi-English Speech Translator API starting...")
    init_db()
    logger.info("Inference mode: %s", os.getenv("INFERENCE_MODE", "api"))
    logger.info("TTS Voice: %s", os.getenv("TTS_VOICE", "Sunita"))
    asyncio.create_task(_prefill_glossary_cache())
    yield
    logger.info("API shutting down.")


app = FastAPI(
    title="Marathi-English Speech Translator",
    description="PWA backend for Marathi ASR + IndicTrans2 + Indic Parler-TTS",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow frontend to call the API
frontend_origin = os.getenv("FRONTEND_ORIGIN", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_origin] if frontend_origin != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Pydantic Models ──────────────────────────────────────────────────────────

class TextToSpeechRequest(BaseModel):
    english_text: Optional[str] = None
    # When the text is already Marathi (e.g. the LLM replied in Marathi),
    # send it here to skip the EN→MR translation step.
    marathi_text: Optional[str] = None
    # Generic path used by the frontend's language selector — skips
    # translation entirely and speaks `text` directly in `language`.
    text: Optional[str] = None
    language: Optional[str] = None
    voice: Optional[str] = None


class SpeechToTextResponse(BaseModel):
    marathi_text: str
    english_text: str
    success: bool = True


class ChatRequest(BaseModel):
    text: str
    reply_language: str = "mr"


class ChatResponse(BaseModel):
    response: str
    response_en: str
    question_en: str
    timings: dict
    translation_failed: bool = False
    success: bool = True


class TextToSpeechResponse(BaseModel):
    marathi_text: str
    audio_base64: str
    word_timings: list
    duration: float
    voice: str
    success: bool = True

class DiseaseTopGuess(BaseModel):
    class_: str = Field(alias="class")
    disease: str
    disease_en: str
    probability: float

    model_config = {"populate_by_name": True}


class DiseaseResponse(BaseModel):
    crop: str
    status: str
    message: str
    is_healthy: bool
    language: str
    note: str = ""
    precautions: list = []
    top: list[DiseaseTopGuess] = []


class CreateChatRequest(BaseModel):
    title: str

class AddMessageRequest(BaseModel):
    role: str
    msg_type: str
    content: dict

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "inference_mode": os.getenv("INFERENCE_MODE", "api"),
        "tts_voice": os.getenv("TTS_VOICE", "Sunita"),
        "device": os.getenv("DEVICE", "cpu"),
        "hf_token_set": bool(os.getenv("HF_TOKEN")),
    }


@app.post("/api/speech-to-text", response_model=SpeechToTextResponse)
async def speech_to_text(audio: UploadFile = File(...), translate: bool = Form(True), language: str = Form("mr")):
    """
    Convert Marathi speech audio to English text.

    Pipeline:
      Audio (WebM/WAV/OGG) → IndicConformer → Marathi Text → IndicTrans2 → English Text
    """
    if not audio.filename:
        raise HTTPException(status_code=400, detail="No audio file provided.")

    logger.info("Received audio: %s (%s)", audio.filename, audio.content_type)

    try:
        audio_bytes = await audio.read()

        if len(audio_bytes) < 100:
            raise HTTPException(status_code=400, detail="Audio file is too small or empty.")

        # Step 1: Transcribe Marathi speech → Marathi text
        marathi_text = await transcribe_marathi(audio_bytes, language)
        logger.info("Transcribed: %s", marathi_text[:100])

        if not marathi_text.strip():
            return SpeechToTextResponse(
                marathi_text="",
                english_text="(No speech detected)",
                success=True,
            )

        # Step 2: Translate Marathi → English (optional — the LLM understands
        # Marathi directly, so the voice-chat flow skips this hop)
        english_text = ""
        if translate:
            english_text = await translate_marathi_to_english(marathi_text)
            logger.info("Translated: %s", english_text[:100])

        return SpeechToTextResponse(
            marathi_text=marathi_text,
            english_text=english_text,
        )

    except HTTPException:
        raise
    except RuntimeError as e:
        logger.error("Model error in speech-to-text: %s", e)
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.exception("Unexpected error in speech-to-text")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")


@app.post("/api/text-to-speech", response_model=TextToSpeechResponse)
async def text_to_speech(request: TextToSpeechRequest):
    """
    Convert English text to Marathi speech audio.

    Pipeline:
      English Text → IndicTrans2 → Marathi Text → Indic Parler-TTS → Audio + Word Timings
    """
    source_text = (request.marathi_text or request.english_text or "").strip()
    if request.text:
        source_text = request.text.strip()

    if not source_text:
        raise HTTPException(status_code=400, detail="No text provided.")

    if len(source_text) > 2000:
        raise HTTPException(status_code=400, detail="Text too long (max 2000 chars).")

    logger.info("TTS request: %s", source_text[:100])

    try:
        # Step 1: Translate English → Marathi (skipped when Marathi was given,
        # or always skipped on the generic text+language path — the LLM
        # already answered in the target language, so nothing to translate).
        if request.text:
            marathi_text = clean_for_translation(source_text) or source_text
        elif request.marathi_text:
            marathi_text = clean_for_translation(source_text) or source_text
        else:
            marathi_text = await translate_english_to_marathi(source_text)
            logger.info("Translated to Marathi: %s", marathi_text[:100])

        if not marathi_text.strip():
            raise HTTPException(status_code=500, detail="Translation returned empty text.")

        # Step 2: Synthesize Marathi speech
        tts_result = await synthesize_marathi_speech(
            marathi_text, voice=request.voice, language=(request.language or "mr")
        )

        return TextToSpeechResponse(
            marathi_text=marathi_text,
            audio_base64=tts_result["audio_base64"],
            word_timings=tts_result["word_timings"],
            duration=tts_result["duration"],
            voice=tts_result["voice"],
        )

    except HTTPException:
        raise
    except RuntimeError as e:
        logger.error("Model error in text-to-speech: %s", e)
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.exception("Unexpected error in text-to-speech")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")


@app.post("/api/disease", response_model=DiseaseResponse)
async def disease_check(
    image: UploadFile = File(...),
    crop: str = Form(...),
    language: str = Form("mr"),
):
    """
    Forward a leaf photo + crop to disease_api (a separate Flask service on
    port 5002 — see disease_api/app.py) and turn its structured result into
    a farmer-facing message in the requested language.
    """
    if not crop.strip():
        raise HTTPException(status_code=400, detail="Please choose a crop.")
    if not image.filename:
        raise HTTPException(status_code=400, detail="Please provide a leaf photo.")

    all_templates = _load_disease_names()["templates"]
    lang = language if language in all_templates else "en"

    image_bytes = await image.read()

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            disease_response = await client.post(
                f"{DISEASE_API_URL}/predict-disease",
                files={"image": (image.filename, image_bytes, image.content_type or "image/jpeg")},
                data={"crop": crop},
            )
    except httpx.ConnectError:
        logger.error(
            "disease_api unreachable at %s — start it with: cd disease_api && python app.py",
            DISEASE_API_URL,
        )
        raise HTTPException(status_code=503, detail=all_templates[lang]["service_unavailable"])
    except httpx.RequestError as e:
        logger.error("Error contacting disease_api: %s", e)
        raise HTTPException(status_code=503, detail=all_templates[lang]["service_unavailable"])

    if disease_response.status_code != 200:
        # Pass disease_api's own error body (bad crop, unreadable image, too large) straight through.
        return JSONResponse(status_code=disease_response.status_code, content=disease_response.json())

    result = disease_response.json()

    try:
        message = _build_disease_message(result, lang)
    except Exception:
        logger.exception("Unexpected error building disease message")
        raise HTTPException(status_code=500, detail="Could not build the result message.")

    top_guesses = [
        DiseaseTopGuess(**{
            "class": g["class"],
            "disease": _disease_label(g["class"], lang),
            "disease_en": _disease_label(g["class"], "en"),
            "probability": g["probability"],
        })
        for g in result["top"]
    ]
    # The returned note is our own translated KVK sentence, not disease_api's raw
    # English text — keyed on presence only (see _build_disease_message's docstring).
    note = all_templates[lang]["kvk_note"] if result.get("note") else ""

    return DiseaseResponse(
        crop=result["crop"],
        status=result["status"],
        message=message,
        is_healthy=result["top"][0]["is_healthy"],
        language=lang,
        note=note,
        precautions=result.get("precautions", []),
        top=top_guesses,
    )


def _get_llm_client() -> AsyncOpenAI:
    """Reuse one client so TCP/TLS connections to NVIDIA are kept alive between requests."""
    global _llm_client
    if _llm_client is None:
        _llm_client = AsyncOpenAI(
            base_url="https://integrate.api.nvidia.com/v1",
            api_key=os.getenv("NVIDIA_API_KEY"),
            timeout=LLM_TIMEOUT,
            max_retries=0,
        )
    return _llm_client


def _llm_extra_body(model: str) -> dict:
    # Hybrid-reasoning models (DeepSeek, Nemotron) think by default; thinking
    # adds many seconds of latency and isn't needed for short advisory answers.
    if "deepseek" in model or "nemotron" in model:
        return {"chat_template_kwargs": {"enable_thinking": False}}
    return {}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Send the farmer's question to the NVIDIA-hosted LLM.

    The LLM always answers in English — it must never write Marathi or Hindi
    itself, since that isn't checked the way disease names are. For mr/hi,
    the question is translated to English first and the English answer is
    translated back afterwards; for en, both hops are skipped.
    """
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text provided.")

    reply_language = request.reply_language or "en"
    needs_translation = reply_language != "en"
    translation_failed = False
    timings = {"translate_in": 0, "llm": 0, "translate_out": 0, "total": 0}
    t_total_start = time.perf_counter()

    # Step 1: translate the farmer's question to English (mr/hi only)
    question_en = text
    if needs_translation:
        t0 = time.perf_counter()
        try:
            translated_question = await translate(text, reply_language, "en")
            if translated_question.strip():
                question_en = translated_question
        except Exception as e:
            logger.warning("Question translation (%s→en) failed: %s", reply_language, e)
            translation_failed = True
        timings["translate_in"] = round((time.perf_counter() - t0) * 1000)

    logger.info(
        "LLM chat request (%s) reply_language=%s question_en=%s",
        LLM_MODEL, reply_language, question_en[:100],
    )

    if needs_translation:
        language_label = ORIGINAL_LANGUAGE_LABELS.get(reply_language, reply_language)
        user_content = (
            f"Farmer's original question ({language_label}): {text}\n"
            f"Machine translation to English (may contain mistakes): {question_en}\n"
            "Answer the farmer's real question in English."
        )
    else:
        user_content = question_en

    messages = [
        {"role": "system", "content": FARMER_SYSTEM_PROMPT.format(language="English")},
        {"role": "user", "content": user_content},
    ]

    def complete(model: str):
        return asyncio.create_task(_get_llm_client().chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.5,
            top_p=0.9,
            max_tokens=LLM_MAX_TOKENS,
            extra_body=_llm_extra_body(model),
        ))

    t0 = time.perf_counter()
    try:
        # Hedged request: if the primary model hasn't answered within
        # LLM_HEDGE_AFTER seconds (free-tier queueing), also ask the fallback
        # model and use whichever answers first.
        completion, failed = None, []
        pending = {complete(LLM_MODEL)}
        timeout = LLM_HEDGE_AFTER
        while completion is None:
            if not pending:
                raise failed[-1].exception()
            done, pending = await asyncio.wait(
                pending, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
            )
            for t in done:
                if t.exception():
                    failed.append(t)
                elif completion is None:
                    completion = t.result()
            if completion is None and timeout is not None and LLM_FALLBACK_MODEL:
                logger.warning("LLM %s slow or failed; also trying %s", LLM_MODEL, LLM_FALLBACK_MODEL)
                pending.add(complete(LLM_FALLBACK_MODEL))
            timeout = None  # hedge only once; then wait for whichever finishes
        for t in pending:
            t.cancel()

        response_en = (completion.choices[0].message.content or "").strip()
        timings["llm"] = round((time.perf_counter() - t0) * 1000)
        logger.info("LLM response (English): %s", response_en[:100])
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unexpected error in chat")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")

    # Step 3: translate the English answer to reply_language (mr/hi only)
    final_response = response_en
    if needs_translation:
        t0 = time.perf_counter()
        try:
            translated_answer = await translate(response_en, "en", reply_language)
            if translated_answer.strip():
                final_response = await _apply_farm_glossary(translated_answer, response_en, reply_language)
            else:
                translation_failed = True
        except Exception as e:
            logger.warning("Answer translation (en→%s) failed: %s", reply_language, e)
            translation_failed = True
        timings["translate_out"] = round((time.perf_counter() - t0) * 1000)

    timings["total"] = round((time.perf_counter() - t_total_start) * 1000)
    logger.info("Chat timings (ms): %s", timings)

    return ChatResponse(
        response=final_response,
        response_en=response_en,
        question_en=question_en,
        timings=timings,
        translation_failed=translation_failed,
    )


@app.post("/api/chats")
def api_create_chat(request: CreateChatRequest):
    try:
        chat_id = create_chat(request.title)
        return {"chat_id": chat_id, "title": request.title}
    except Exception as e:
        logger.exception("Error creating chat")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/chats")
def api_get_chats():
    try:
        chats = get_chats()
        return {"chats": chats}
    except Exception as e:
        logger.exception("Error getting chats")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/chats/{chat_id}/messages")
def api_get_messages(chat_id: int):
    try:
        messages = get_chat_messages(chat_id)
        return {"messages": messages}
    except Exception as e:
        logger.exception("Error getting messages")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chats/{chat_id}/messages")
def api_add_message(chat_id: int, request: AddMessageRequest):
    try:
        msg_id = add_message(chat_id, request.role, request.msg_type, request.content)
        return {"message_id": msg_id, "success": True}
    except Exception as e:
        logger.exception("Error adding message")
        raise HTTPException(status_code=500, detail=str(e))


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
