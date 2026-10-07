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
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
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
from models.translation import translate_marathi_to_english, translate_english_to_marathi
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

LANGUAGE_NAMES = {
    "mr": "Marathi", "hi": "Hindi", "en": "English", "gu": "Gujarati",
    "kn": "Kannada", "te": "Telugu", "ta": "Tamil", "bn": "Bengali", "pa": "Punjabi",
}

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
    return entry.get(language) or entry.get("en") or class_name.split("___", 1)[-1].replace("_", " ")


def _crop_label(crop: str, language: str) -> str:
    entry = _load_disease_names()["crops"].get(crop, {})
    return entry.get(language) or entry.get("en") or crop


def _build_disease_message(result: dict, language: str) -> str:
    """
    Build the farmer-facing message from disease_api's structured fields
    (status, top[0], top[1], is_healthy) using the checked name table and
    fixed templates — never by machine-translating disease_api's English
    `message`, since a wrong disease name could mislead a farmer (CLAUDE.md).
    """
    templates = _load_disease_names()["templates"][language]
    top = result["top"]
    best = top[0]

    if result["status"] == "not_sure":
        return templates["not_sure"]

    crop_label = _crop_label(result["crop"], language)
    if best["is_healthy"]:
        return templates["healthy"].format(crop=crop_label)

    disease_label = _disease_label(best["class"], language)
    if len(top) > 1 and top[1]["probability"] >= 0.25:
        second = templates["healthy_word"] if top[1]["is_healthy"] else _disease_label(top[1]["class"], language)
        return templates["disease_two"].format(crop=crop_label, disease=disease_label, second=second)
    return templates["disease_one"].format(crop=crop_label, disease=disease_label)

FARMER_SYSTEM_PROMPT = (
    "You are Krishi Mitra, an agricultural advisor for small farmers in India. "
    "Always reply in {language} using simple, everyday words a farmer understands. "
    "Keep answers short: 3 to 6 sentences, practical and actionable "
    "(what to do, how much, when). Mention locally available remedies and "
    "safe pesticide use where relevant, and suggest contacting the local "
    "Krishi Vigyan Kendra for serious problems. Your reply will be read aloud "
    "by a text-to-speech engine, so write plain sentences only: no markdown, "
    "no bullet points, no headings, no emojis, no tables."
)

_llm_client: Optional[AsyncOpenAI] = None

# ─── App Setup ────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    logger.info("🚀 Marathi-English Speech Translator API starting...")
    init_db()
    logger.info("Inference mode: %s", os.getenv("INFERENCE_MODE", "api"))
    logger.info("TTS Voice: %s", os.getenv("TTS_VOICE", "Sunita"))
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
    success: bool = True


class TextToSpeechResponse(BaseModel):
    marathi_text: str
    audio_base64: str
    word_timings: list
    duration: float
    voice: str
    success: bool = True

class DiseaseResponse(BaseModel):
    crop: str
    status: str
    message: str
    is_healthy: bool
    language: str
    note: str = ""
    precautions: list = []


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
async def speech_to_text(audio: UploadFile = File(...), translate: bool = Form(True)):
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
        marathi_text = await transcribe_marathi(audio_bytes)
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

    if not source_text:
        raise HTTPException(status_code=400, detail="No text provided.")

    if len(source_text) > 2000:
        raise HTTPException(status_code=400, detail="Text too long (max 2000 chars).")

    logger.info("TTS request: %s", source_text[:100])

    try:
        # Step 1: Translate English → Marathi (skipped when Marathi was given)
        if request.marathi_text:
            marathi_text = clean_for_translation(source_text) or source_text
        else:
            marathi_text = await translate_english_to_marathi(source_text)
            logger.info("Translated to Marathi: %s", marathi_text[:100])

        if not marathi_text.strip():
            raise HTTPException(status_code=500, detail="Translation returned empty text.")

        # Step 2: Synthesize Marathi speech
        tts_result = await synthesize_marathi_speech(marathi_text, voice=request.voice)

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

    image_bytes = await image.read()

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            disease_response = await client.post(
                f"{DISEASE_API_URL}/predict-disease",
                files={"image": (image.filename, image_bytes, image.content_type or "image/jpeg")},
                data={"crop": crop},
            )
    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail="Disease detection service is not running. Start it with: cd disease_api && python app.py",
        )
    except httpx.RequestError as e:
        logger.error("Error contacting disease_api: %s", e)
        raise HTTPException(status_code=503, detail="Disease detection service is unreachable.")

    if disease_response.status_code != 200:
        # Pass disease_api's own error body (bad crop, unreadable image, too large) straight through.
        return JSONResponse(status_code=disease_response.status_code, content=disease_response.json())

    result = disease_response.json()
    all_templates = _load_disease_names()["templates"]
    lang = language if language in all_templates else "en"

    try:
        message = _build_disease_message(result, lang)
    except Exception:
        logger.exception("Unexpected error building disease message")
        raise HTTPException(status_code=500, detail="Could not build the result message.")

    note = result.get("note", "")
    if lang == "en" and note:
        message += all_templates["en"]["note_suffix"].format(note=note)

    return DiseaseResponse(
        crop=result["crop"],
        status=result["status"],
        message=message,
        is_healthy=result["top"][0]["is_healthy"],
        language=lang,
        note=note,
        precautions=result.get("precautions", []),
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

    The LLM answers directly in `reply_language`, which removes the two slow
    translation hops (MR→EN before the LLM, EN→MR after it).
    """
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text provided.")

    language_name = LANGUAGE_NAMES.get(request.reply_language, "English")
    logger.info("LLM chat request (%s, reply in %s): %s", LLM_MODEL, language_name, text[:100])

    messages = [
        {"role": "system", "content": FARMER_SYSTEM_PROMPT.format(language=language_name)},
        {"role": "user", "content": text},
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

        response_text = (completion.choices[0].message.content or "").strip()
        logger.info("LLM response: %s", response_text[:100])
        return ChatResponse(response=response_text)

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unexpected error in chat")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")


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
