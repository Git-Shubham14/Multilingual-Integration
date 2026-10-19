/* ============================================================
   app.js — Marathi-English Speech Translator PWA
   ============================================================

   Modules:
   - Config        : Settings management (API URL, voice, HF token)
   - API           : Backend calls (speech-to-text, text-to-speech)
   - SpeechInput   : Mic recording + Web Speech API live transcript
   - TTSPlayer     : Audio playback + word highlighting
   - ChatUI        : Message rendering
   - App           : Main coordinator
   ============================================================ */

"use strict";

/* ─── Config ─────────────────────────────────────────────── */
const Config = (() => {
  const DEFAULTS = {
    apiUrl: "http://localhost:8000",
    voice: "Sunita",
    hfToken: "hf_your_token_here",
    language: "mr",
  };

  let _settings = { ...DEFAULTS };

  function load() {
    try {
      const saved = localStorage.getItem("marathi_translator_settings");
      if (saved) {
        _settings = { ...DEFAULTS, ...JSON.parse(saved) };
      }
    } catch (e) {
      console.warn("Failed to load settings:", e);
    }
  }

  function save(updates) {
    _settings = { ...DEFAULTS, ..._settings, ...updates };
    try {
      localStorage.setItem("marathi_translator_settings", JSON.stringify(_settings));
    } catch (e) {
      console.warn("Failed to save settings:", e);
    }
  }

  function get(key) { return _settings[key]; }

  load();
  return { get, save, load };
})();

/* ─── Language Selector (mr / hi / en) ───────────────────── */
const LanguageSelector = (() => {
  const _listeners = [];

  function getLanguage() {
    return Config.get("language") || "mr";
  }

  // Lets other modules (e.g. CropAdvisor) re-localize their own UI text
  // when the farmer switches language, without LanguageSelector needing
  // to know anything about them.
  function onChange(callback) {
    _listeners.push(callback);
  }

  function _applyActiveState(lang) {
    document.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lang === lang);
    });
  }

  function init() {
    document.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        Config.save({ language: btn.dataset.lang });
        _applyActiveState(btn.dataset.lang);
        _listeners.forEach((cb) => cb(btn.dataset.lang));
      });
    });
    _applyActiveState(getLanguage());
  }

  return { init, getLanguage, onChange };
})();


/* ─── API Client ─────────────────────────────────────────── */
const API = (() => {
  async function speechToText(audioBlob) {
    const apiUrl = Config.get("apiUrl");
    const formData = new FormData();
    formData.append("audio", audioBlob, "recording.wav");
    // The LLM understands Marathi directly — skip the MR→EN translation hop.
    formData.append("translate", "false");
    formData.append("language", LanguageSelector.getLanguage());

    const response = await fetch(`${apiUrl}/api/speech-to-text`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `API Error: ${response.status}`);
    }

    return response.json();
  }

  async function textToSpeech(text, voice, language = LanguageSelector.getLanguage()) {
    const apiUrl = Config.get("apiUrl");
    const response = await fetch(`${apiUrl}/api/text-to-speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, language: language, voice: voice }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `API Error: ${response.status}`);
    }

    return response.json();
  }

  async function chat(text) {
    const apiUrl = Config.get("apiUrl");
    const response = await fetch(`${apiUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, reply_language: LanguageSelector.getLanguage() }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `API Error: ${response.status}`);
    }

    return response.json();
  }

  async function healthCheck() {
    const apiUrl = Config.get("apiUrl");
    const response = await fetch(`${apiUrl}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.json();
  }

  // Talukas, soil types and crops for the Crop Advisor form's dropdowns.
  async function cropOptions() {
    const apiUrl = Config.get("apiUrl");
    const response = await fetch(
      `${apiUrl}/api/crop/options?language=${LanguageSelector.getLanguage()}`
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `API Error: ${response.status}`);
    }
    return response.json();
  }

  // Crop recommendation + Nemotron explanation. 20s client timeout — the
  // backend's own LLM budget is 10s, so this leaves slack for crop_api and
  // network time before giving up with a friendly message.
  async function cropAdvice(payload) {
    const apiUrl = Config.get("apiUrl");
    const response = await fetch(`${apiUrl}/api/crop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errors = Array.isArray(data.errors) ? data.errors.join(" ") : null;
      const err = new Error(data.detail || errors || `API Error: ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return data;
  }

  async function createChat(title) {
    const apiUrl = Config.get("apiUrl");
    const response = await fetch(`${apiUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return response.json();
  }

  async function getChats() {
    const apiUrl = Config.get("apiUrl");
    const response = await fetch(`${apiUrl}/api/chats`);
    return response.json();
  }

  async function getChatMessages(chatId) {
    const apiUrl = Config.get("apiUrl");
    const response = await fetch(`${apiUrl}/api/chats/${chatId}/messages`);
    return response.json();
  }

  async function saveMessage(chatId, role, msgType, content) {
    const apiUrl = Config.get("apiUrl");
    const response = await fetch(`${apiUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, msg_type: msgType, content }),
    });
    return response.json();
  }

  return {
    speechToText, textToSpeech, healthCheck, chat, createChat, getChats, getChatMessages, saveMessage,
    cropOptions, cropAdvice,
  };
})();

/* ─── Disease Check (leaf photo upload) ──────────────────── */
const DiseaseCheck = (() => {
  const MAX_SIDE = 1280;
  const JPEG_QUALITY = 0.85;

  // Shrink the photo in the browser before upload: at most 1280px on the
  // longer side, re-encoded as JPEG, so slow mobile uploads stay fast.
  function _compressImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        const longSide = Math.max(width, height);
        if (longSide > MAX_SIDE) {
          const scale = MAX_SIDE / longSide;
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Could not process the photo."))),
          "image/jpeg",
          JPEG_QUALITY
        );
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read the photo."));
      };

      img.src = url;
    });
  }

  async function checkDisease(file, crop) {
    const apiUrl = Config.get("apiUrl");
    const compressed = await _compressImage(file);

    const formData = new FormData();
    formData.append("image", compressed, "leaf.jpg");
    formData.append("crop", crop);
    formData.append("language", LanguageSelector.getLanguage());

    const response = await fetch(`${apiUrl}/api/disease`, {
      method: "POST",
      body: formData,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // disease_api's own 400/413 errors come back as {"error": ...}; backend-raised
      // errors (no crop, service down) come back as {"detail": ...} — check both.
      const err = new Error(data.error || data.detail || `API Error: ${response.status}`);
      err.status = response.status;
      throw err;
    }

    return data;
  }

  return { checkDisease };
})();


/* ─── Chat History ───────────────────────────────────────── */
const ChatHistory = (() => {
  let currentChatId = null;

  async function ensureChatId(title) {
    if (!currentChatId) {
      try {
        const chat = await API.createChat(title);
        currentChatId = chat.chat_id;
        await loadSidebar();
      } catch (err) {
        console.error("Failed to create chat", err);
      }
    }
    return currentChatId;
  }

  async function loadSidebar() {
    try {
      const result = await API.getChats();
      const list = document.getElementById("chat-list");
      list.innerHTML = "";
      for (const chat of result.chats) {
        const li = document.createElement("li");
        li.className = "chat-item" + (chat.id === currentChatId ? " active" : "");
        li.textContent = chat.title;
        li.addEventListener("click", () => loadChat(chat.id));
        list.appendChild(li);
      }
    } catch (err) {
      console.error("Failed to load sidebar", err);
    }
  }

  async function loadChat(chatId) {
    currentChatId = chatId;
    document.getElementById("chat-area").innerHTML = "";
    
    // Restore welcome screen just to hide it cleanly when messages load
    const welcome = document.getElementById("welcome-screen");
    if (welcome) welcome.classList.add("hidden");
    
    await loadSidebar(); // update active class
    
    // on mobile, close sidebar
    document.getElementById("history-sidebar").classList.remove("open");
    
    try {
      const result = await API.getChatMessages(chatId);
      for (const msg of result.messages) {
        if (msg.msg_type === "speech_result") {
          ChatUI.addSpeechResult(msg.content.marathi_text, msg.content.english_text);
        } else if (msg.msg_type === "user_text") {
          ChatUI.addUserText(msg.content.english_text);
        } else if (msg.msg_type === "bot_tts") {
          // Older chats stored an English reply separately from the Marathi TTS text
          if (msg.content.ai_response && !msg.content.reply_language) {
            ChatUI.addBotText("AI Response (English)", msg.content.ai_response);
          }

          ChatUI.addTTSResult(
            msg.content.marathi_text,
            msg.content.word_timings,
            msg.content.audio_base64,
            msg.content.voice,
            msg.content.duration
          );
        } else if (msg.msg_type === "bot_text") {
          ChatUI.addBotText("Voice not available", msg.content.ai_response);
        }
      }
    } catch (err) {
      console.error("Failed to load messages", err);
    }
  }

  function startNewChat() {
    currentChatId = null;
    document.getElementById("chat-area").innerHTML = "";
    
    // Add welcome back if exists, or recreate it
    let welcome = document.getElementById("welcome-screen");
    if (!welcome) {
      welcome = document.createElement("div");
      welcome.className = "welcome-screen";
      welcome.id = "welcome-screen";
      welcome.innerHTML = `
        <div class="welcome-icon" aria-hidden="true">🌾</div>
        <div>
          <h1 class="welcome-title">नमस्कार! Speak <span>Marathi</span>,<br />Hear it in <span>English</span></h1>
          <p class="welcome-subtitle">Hold the mic button and speak in Marathi.<br />Or type English text to hear it spoken in Marathi.</p>
        </div>
        <div class="welcome-tips" role="list">
          <div class="tip-card" role="listitem"><span class="tip-icon">🎙️</span><span>Hold mic &amp; speak <strong>Marathi</strong></span></div>
          <div class="tip-card" role="listitem"><span class="tip-icon">📝</span><span>Type <strong>English</strong> text</span></div>
          <div class="tip-card" role="listitem"><span class="tip-icon">🔊</span><span>Tap ↺ to <strong>replay</strong> Marathi speech</span></div>
        </div>
      `;
      document.getElementById("chat-area").appendChild(welcome);
    } else {
      welcome.classList.remove("hidden");
      document.getElementById("chat-area").appendChild(welcome);
    }
    
    loadSidebar();
    document.getElementById("history-sidebar").classList.remove("open");
  }

  function init() {
    document.getElementById("new-chat-btn").addEventListener("click", startNewChat);
    document.getElementById("sidebar-toggle-btn").addEventListener("click", () => {
      document.getElementById("history-sidebar").classList.toggle("open");
    });
    document.getElementById("sidebar-close-btn").addEventListener("click", () => {
      document.getElementById("history-sidebar").classList.remove("open");
    });
    loadSidebar();
  }

  function getChatId() { return currentChatId; }

  return { init, ensureChatId, getChatId };
})();


/* ─── Toast Notifications ────────────────────────────────── */
const Toast = (() => {
  let container;

  function init() {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  function show(message, type = "info", duration = 3000) {
    if (!container) init();
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  return { show };
})();


/* ─── TTS Player ─────────────────────────────────────────── */
const TTSPlayer = (() => {
  let _audioCtx = null;
  let _sourceNode = null;
  let _audioBuffer = null;
  let _wordTimings = [];
  let _startTime = 0;
  let _pausedAt = 0;
  let _isPlaying = false;
  let _highlightInterval = null;
  let _onWordChange = null;
  let _onProgress = null;
  let _onEnd = null;

  function _getAudioCtx() {
    if (!_audioCtx || _audioCtx.state === "closed") {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return _audioCtx;
  }

  async function load(base64Audio, wordTimings, callbacks = {}) {
    stop();
    _wordTimings = wordTimings || [];
    _onWordChange = callbacks.onWordChange || null;
    _onProgress = callbacks.onProgress || null;
    _onEnd = callbacks.onEnd || null;
    _pausedAt = 0;

    const ctx = _getAudioCtx();
    const bytes = Uint8Array.from(atob(base64Audio), (c) => c.charCodeAt(0));
    _audioBuffer = await ctx.decodeAudioData(bytes.buffer);

    // Scale word timings to match exact decoded audio duration
    if (_wordTimings.length > 0 && _audioBuffer && _audioBuffer.duration > 0) {
      const actualDuration = _audioBuffer.duration;
      // Get the backend's estimated duration from the last word's end time, or 1.0
      const estimatedDuration = _wordTimings[_wordTimings.length - 1].end || 1.0;
      const scale = actualDuration / estimatedDuration;

      _wordTimings = _wordTimings.map(w => ({
        word: w.word,
        start: w.start * scale,
        end: w.end * scale
      }));
    }
  }

  function _startHighlighting(offsetTime = 0) {
    if (_highlightInterval) clearInterval(_highlightInterval);

    _highlightInterval = setInterval(() => {
      if (!_isPlaying) return;

      const ctx = _audioCtx;
      const elapsed = ctx.currentTime - _startTime + offsetTime;
      const total = _audioBuffer ? _audioBuffer.duration : 1;
      const progress = Math.min((elapsed / total) * 100, 100);

      if (_onProgress) _onProgress(progress, elapsed, total);

      // Find current word
      let activeIdx = -1;
      for (let i = 0; i < _wordTimings.length; i++) {
        const w = _wordTimings[i];
        if (elapsed >= w.start && elapsed < w.end) {
          activeIdx = i;
          break;
        }
      }
      if (_onWordChange) _onWordChange(activeIdx, elapsed);

      if (elapsed >= total) {
        _finishPlayback();
      }
    }, 50);
  }

  function _finishPlayback() {
    _isPlaying = false;
    if (_highlightInterval) clearInterval(_highlightInterval);
    if (_onEnd) _onEnd();
    if (_onWordChange) _onWordChange(-1, 0);
    if (_onProgress) _onProgress(0, 0, 1);
    _pausedAt = 0;
  }

  function play(fromOffset = 0) {
    if (!_audioBuffer) return;
    stop();

    const ctx = _getAudioCtx();
    if (ctx.state === "suspended") ctx.resume();

    _sourceNode = ctx.createBufferSource();
    _sourceNode.buffer = _audioBuffer;
    _sourceNode.connect(ctx.destination);
    _sourceNode.start(0, fromOffset);
    _sourceNode.onended = () => {
      if (_isPlaying) _finishPlayback();
    };

    _startTime = ctx.currentTime - fromOffset;
    _isPlaying = true;
    _startHighlighting(fromOffset);
  }

  function stop() {
    if (_sourceNode) {
      try {
        _sourceNode.stop();
        _sourceNode.disconnect();
      } catch (e) { /* ignore */ }
      _sourceNode = null;
    }
    _isPlaying = false;
    if (_highlightInterval) {
      clearInterval(_highlightInterval);
      _highlightInterval = null;
    }
  }

  function pause() {
    if (!_isPlaying || !_audioCtx) return;
    _pausedAt = _audioCtx.currentTime - _startTime;
    stop();
  }

  function resume() {
    play(_pausedAt);
  }

  function replay() {
    _pausedAt = 0;
    play(0);
  }

  function isPlaying() { return _isPlaying; }
  function isPaused() { return !_isPlaying && _pausedAt > 0; }

  return { load, play, stop, pause, resume, replay, isPlaying, isPaused };
})();


/* ─── Speech Input (Mic Recording + Web Speech API) ──────── */
const SpeechInput = (() => {
  let _mediaRecorder = null;
  let _audioChunks = [];
  let _recognition = null;
  let _isRecording = false;
  let _onInterim = null;    // live Marathi text callback
  let _onFinal = null;      // final audio blob callback
  let _onError = null;

  // Setup Web Speech API for live Marathi transcription (Chrome only)
  function _initSpeechRecognition() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) return null;

    const recog = new SpeechRecognition();
    recog.lang = "mr-IN";        // Marathi India
    recog.continuous = true;
    recog.interimResults = true;
    recog.maxAlternatives = 1;

    recog.onresult = (event) => {
      let interimText = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += t;
        } else {
          interimText += t;
        }
      }
      if (_onInterim) _onInterim(finalText + interimText, finalText, interimText);
    };

    recog.onerror = (e) => {
      if (e.error !== "no-speech") {
        console.warn("Speech recognition error:", e.error);
      }
    };

    return recog;
  }

  async function _startMediaRecorder(stream) {
    // Prefer audio/webm;codecs=opus (best quality), fall back to audio/ogg or audio/wav
    const mimeTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
      "audio/wav",
    ];
    let mimeType = "";
    for (const mt of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mt)) {
        mimeType = mt;
        break;
      }
    }

    _audioChunks = [];
    const options = mimeType ? { mimeType } : {};
    _mediaRecorder = new MediaRecorder(stream, options);

    _mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) _audioChunks.push(e.data);
    };

    _mediaRecorder.onstop = () => {
      const blob = new Blob(_audioChunks, { type: mimeType || "audio/webm" });
      if (_onFinal) _onFinal(blob);
    };

    _mediaRecorder.start(100); // collect chunks every 100ms
  }

  async function startRecording(callbacks = {}) {
    if (_isRecording) return;
    _onInterim = callbacks.onInterim || null;
    _onFinal = callbacks.onFinal || null;
    _onError = callbacks.onError || null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      await _startMediaRecorder(stream);
      _isRecording = true;

      // Start live speech recognition in parallel
      _recognition = _initSpeechRecognition();
      if (_recognition) {
        _recognition.start();
      }

      return stream;
    } catch (err) {
      console.error("Mic access error:", err);
      if (_onError) _onError(err.name === "NotAllowedError"
        ? "Microphone permission denied. Please allow mic access."
        : "Could not access microphone: " + err.message
      );
      return null;
    }
  }

  function stopRecording() {
    if (!_isRecording) return;
    _isRecording = false;

    if (_recognition) {
      try { _recognition.stop(); } catch (e) { /* ignore */ }
      _recognition = null;
    }

    if (_mediaRecorder && _mediaRecorder.state !== "inactive") {
      _mediaRecorder.stop();
      // Stop mic stream
      _mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    }
  }

  function isRecording() { return _isRecording; }
  function hasWebSpeech() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  return { startRecording, stopRecording, isRecording, hasWebSpeech };
})();


/* ─── Chat UI ─────────────────────────────────────────────── */
const ChatUI = (() => {
  let _chatArea;
  let _welcomeScreen;

  function init(chatArea, welcomeScreen) {
    _chatArea = chatArea;
    _welcomeScreen = welcomeScreen;
  }

  function _hideWelcome() {
    if (_welcomeScreen && !_welcomeScreen.classList.contains("hidden")) {
      _welcomeScreen.classList.add("hidden");
    }
  }

  function _scrollToBottom() {
    requestAnimationFrame(() => {
      _chatArea.scrollTop = _chatArea.scrollHeight;
    });
  }

  function _createAvatar(type) {
    const el = document.createElement("div");
    el.className = "message-avatar";
    el.textContent = type === "user" ? "🧑" : "🤖";
    return el;
  }

  function _createLabel(text) {
    const el = document.createElement("div");
    el.className = "message-label";
    el.textContent = text;
    return el;
  }

  /**
   * Add a user Marathi speech message (2 bubbles: Marathi + English)
   */
  function addSpeechResult(marathiText, englishText) {
    _hideWelcome();

    // User side: Marathi speech bubble
    const userMsg = document.createElement("div");
    userMsg.className = "message user";
    const userBody = document.createElement("div");
    userBody.className = "message-body";
    userBody.appendChild(_createLabel("आपण बोललात (Marathi)"));
    const marathiBubble = document.createElement("div");
    marathiBubble.className = "bubble marathi-speech";
    marathiBubble.textContent = marathiText;
    userBody.appendChild(marathiBubble);
    userMsg.appendChild(_createAvatar("user"));
    userMsg.appendChild(userBody);
    _chatArea.appendChild(userMsg);

    if (!englishText) {
      _scrollToBottom();
      return { userMsg, botMsg: null };
    }

    // Bot side: English translation bubble
    const botMsg = document.createElement("div");
    botMsg.className = "message bot";
    const botBody = document.createElement("div");
    botBody.className = "message-body";
    botBody.appendChild(_createLabel("English Translation"));
    const englishBubble = document.createElement("div");
    englishBubble.className = "bubble english-translation";
    englishBubble.textContent = englishText;
    botBody.appendChild(englishBubble);
    botMsg.appendChild(_createAvatar("bot"));
    botMsg.appendChild(botBody);
    _chatArea.appendChild(botMsg);

    _scrollToBottom();
    return { userMsg, botMsg };
  }

  /**
   * Add a plain bot text bubble (textContent — LLM output is never parsed as HTML)
   */
  function addBotText(label, text) {
    _hideWelcome();
    const msg = document.createElement("div");
    msg.className = "message bot";
    const body = document.createElement("div");
    body.className = "message-body";
    body.appendChild(_createLabel(label));
    const bubble = document.createElement("div");
    bubble.className = "bubble english-translation";
    bubble.textContent = text;
    body.appendChild(bubble);
    msg.appendChild(_createAvatar("bot"));
    msg.appendChild(body);
    _chatArea.appendChild(msg);
    _scrollToBottom();
    return msg;
  }

  /**
   * Add user English text message
   */
  function addUserText(englishText) {
    _hideWelcome();
    const msg = document.createElement("div");
    msg.className = "message user";
    const body = document.createElement("div");
    body.className = "message-body";
    body.appendChild(_createLabel("English Text"));
    const bubble = document.createElement("div");
    bubble.className = "bubble user-text";
    bubble.textContent = englishText;
    body.appendChild(bubble);
    msg.appendChild(_createAvatar("user"));
    msg.appendChild(body);
    _chatArea.appendChild(msg);
    _scrollToBottom();
    return msg;
  }

  /**
   * Add loading typing bubble (returns element to remove later)
   */
  function addTypingBubble() {
    _hideWelcome();
    const msg = document.createElement("div");
    msg.className = "message bot";
    const body = document.createElement("div");
    body.className = "message-body";
    const typing = document.createElement("div");
    typing.className = "typing-bubble";
    [1, 2, 3].forEach(() => {
      const dot = document.createElement("div");
      dot.className = "typing-dot";
      typing.appendChild(dot);
    });
    body.appendChild(typing);
    msg.appendChild(_createAvatar("bot"));
    msg.appendChild(body);
    _chatArea.appendChild(msg);
    _scrollToBottom();
    return msg;
  }

  /**
   * Add TTS result bubble with word highlighting + player controls
   */
  function addTTSResult(marathiText, wordTimings, audioBase64, voice, duration) {
    const msg = document.createElement("div");
    msg.className = "message bot";
    const body = document.createElement("div");
    body.className = "message-body";
    body.appendChild(_createLabel(`🔊 Marathi Speech (${voice})`));

    const bubble = document.createElement("div");
    bubble.className = "bubble tts-bubble";

    // Word spans
    const wordsDiv = document.createElement("div");
    wordsDiv.className = "tts-words";

    const wordSpans = wordTimings.map((w, i) => {
      const span = document.createElement("span");
      span.className = "tts-word";
      span.dataset.index = i;
      span.textContent = w.word + " ";
      wordsDiv.appendChild(span);
      return span;
    });

    // If no word timings, just show plain text
    if (wordTimings.length === 0) {
      wordsDiv.textContent = marathiText;
      wordsDiv.style.fontFamily = "'Noto Sans Devanagari', sans-serif";
    }

    bubble.appendChild(wordsDiv);

    // Player controls
    const player = document.createElement("div");
    player.className = "tts-player";

    const controls = document.createElement("div");
    controls.className = "tts-controls";

    // Play/Pause button
    const playBtn = document.createElement("button");
    playBtn.className = "tts-btn";
    playBtn.id = `play-${Date.now()}`;
    playBtn.title = "Play";
    playBtn.innerHTML = "▶";
    playBtn.setAttribute("aria-label", "Play Marathi speech");

    // Replay button
    const replayBtn = document.createElement("button");
    replayBtn.className = "tts-btn";
    replayBtn.title = "Replay from start";
    replayBtn.innerHTML = "↺";
    replayBtn.setAttribute("aria-label", "Replay Marathi speech");

    // Progress bar
    const progressBar = document.createElement("div");
    progressBar.className = "tts-progress";
    const progressFill = document.createElement("div");
    progressFill.className = "tts-progress-fill";
    progressBar.appendChild(progressFill);

    // Time display
    const timeEl = document.createElement("div");
    timeEl.className = "tts-time";
    timeEl.textContent = `0:00 / ${_formatTime(duration)}`;

    // Voice badge
    const voiceBadge = document.createElement("div");
    voiceBadge.className = "tts-voice-badge";
    voiceBadge.textContent = voice;

    controls.appendChild(playBtn);
    controls.appendChild(replayBtn);
    controls.appendChild(progressBar);
    controls.appendChild(timeEl);
    controls.appendChild(voiceBadge);
    player.appendChild(controls);
    bubble.appendChild(player);
    body.appendChild(bubble);

    msg.appendChild(_createAvatar("bot"));
    msg.appendChild(body);
    _chatArea.appendChild(msg);
    _scrollToBottom();

    // ── Wire up TTS player ──────────────────────────────────
    let playerLoaded = false;

    async function _ensureLoaded() {
      if (playerLoaded) return;
      playerLoaded = true;
      await TTSPlayer.load(audioBase64, wordTimings, {
        onWordChange: (activeIdx) => {
          wordSpans.forEach((span, i) => {
            span.classList.toggle("active", i === activeIdx);
            span.classList.toggle("spoken", activeIdx >= 0 && i < activeIdx);
          });
        },
        onProgress: (pct, elapsed, total) => {
          progressFill.style.width = pct + "%";
          timeEl.textContent = `${_formatTime(elapsed)} / ${_formatTime(total)}`;
        },
        onEnd: () => {
          playBtn.innerHTML = "▶";
          playBtn.classList.remove("playing");
          wordSpans.forEach((s) => s.classList.remove("active", "spoken"));
          progressFill.style.width = "0%";
          timeEl.textContent = `0:00 / ${_formatTime(duration)}`;
        },
      });
    }

    playBtn.addEventListener("click", async () => {
      await _ensureLoaded();
      if (TTSPlayer.isPlaying()) {
        TTSPlayer.pause();
        playBtn.innerHTML = "▶";
        playBtn.classList.remove("playing");
      } else if (TTSPlayer.isPaused()) {
        TTSPlayer.resume();
        playBtn.innerHTML = "⏸";
        playBtn.classList.add("playing");
      } else {
        TTSPlayer.play(0);
        playBtn.innerHTML = "⏸";
        playBtn.classList.add("playing");
      }
    });

    replayBtn.addEventListener("click", async () => {
      await _ensureLoaded();
      TTSPlayer.replay();
      playBtn.innerHTML = "⏸";
      playBtn.classList.add("playing");
    });

    return msg;
  }

  /**
   * Add a user leaf-photo thumbnail bubble
   */
  function addUserPhoto(thumbnailUrl, crop) {
    _hideWelcome();
    const msg = document.createElement("div");
    msg.className = "message user";
    const body = document.createElement("div");
    body.className = "message-body";
    body.appendChild(_createLabel(`Leaf Photo (${crop})`));
    const bubble = document.createElement("div");
    bubble.className = "bubble photo-bubble";
    const img = document.createElement("img");
    img.className = "photo-thumbnail";
    img.src = thumbnailUrl;
    img.alt = `${crop} leaf photo`;
    img.addEventListener("load", () => URL.revokeObjectURL(thumbnailUrl));
    bubble.appendChild(img);
    body.appendChild(bubble);
    msg.appendChild(_createAvatar("user"));
    msg.appendChild(body);
    _chatArea.appendChild(msg);
    _scrollToBottom();
    return msg;
  }

  /**
   * Add a "Checking your leaf..." loading bubble (bot side, returns element to remove later)
   */
  function addDiseaseLoading(text) {
    _hideWelcome();
    const msg = document.createElement("div");
    msg.className = "message bot";
    const body = document.createElement("div");
    body.className = "message-body";
    const bubble = document.createElement("div");
    bubble.className = "bubble english-translation disease-loading";
    const label = document.createElement("span");
    label.textContent = text;
    bubble.appendChild(label);
    const dotRow = document.createElement("div");
    dotRow.className = "typing-dot-row";
    [1, 2, 3].forEach(() => {
      const dot = document.createElement("div");
      dot.className = "typing-dot";
      dotRow.appendChild(dot);
    });
    bubble.appendChild(dotRow);
    body.appendChild(bubble);
    msg.appendChild(_createAvatar("bot"));
    msg.appendChild(body);
    _chatArea.appendChild(msg);
    _scrollToBottom();
    return msg;
  }

  /**
   * Add the disease-check result bubble (bot side).
   * "ok": message + both guesses as "name (English name) — NN%".
   * "not_sure": only the message, no guesses.
   */
  function addDiseaseResult(result) {
    _hideWelcome();
    const msg = document.createElement("div");
    msg.className = "message bot";
    const body = document.createElement("div");
    body.className = "message-body";
    body.appendChild(_createLabel("🌿 Leaf Check Result"));

    const bubble = document.createElement("div");
    bubble.className = "bubble disease-result";

    const messageEl = document.createElement("div");
    messageEl.className = "disease-message";
    messageEl.textContent = result.message;
    bubble.appendChild(messageEl);

    if (result.status === "ok" && Array.isArray(result.top) && result.top.length > 0) {
      const guesses = document.createElement("div");
      guesses.className = "disease-guesses";
      result.top.forEach((g) => {
        const row = document.createElement("div");
        row.className = "disease-guess-row";
        const pct = Math.round((g.probability || 0) * 100);
        row.textContent = `${g.disease} (${g.disease_en}) — ${pct}%`;
        guesses.appendChild(row);
      });
      bubble.appendChild(guesses);
    }

    if (Array.isArray(result.precautions) && result.precautions.length > 0) {
      const precautionsEl = document.createElement("div");
      precautionsEl.className = "disease-precautions";

      const title = document.createElement("div");
      title.className = "disease-precautions-title";
      title.textContent = result.precautions_title || "Precautions";
      precautionsEl.appendChild(title);

      const list = document.createElement("ul");
      list.className = "disease-precautions-list";
      result.precautions.forEach((line) => {
        const li = document.createElement("li");
        li.textContent = line;
        list.appendChild(li);
      });
      precautionsEl.appendChild(list);

      bubble.appendChild(precautionsEl);
    }

    body.appendChild(bubble);
    msg.appendChild(_createAvatar("bot"));
    msg.appendChild(body);
    _chatArea.appendChild(msg);
    _scrollToBottom();
    return msg;
  }

  /**
   * Add an error bubble (bot side)
   */
  function addError(message) {
    const msg = document.createElement("div");
    msg.className = "message bot";
    const body = document.createElement("div");
    body.className = "message-body";
    const bubble = document.createElement("div");
    bubble.className = "bubble error";
    bubble.textContent = "⚠️ " + message;
    body.appendChild(bubble);
    msg.appendChild(_createAvatar("bot"));
    msg.appendChild(body);
    _chatArea.appendChild(msg);
    _scrollToBottom();
    return msg;
  }

  /**
   * Add the Crop Advisor result bubble (bot side).
   * `labels` is CropI18n's label object for the farmer's current language
   * (resultLabel, riskLabel, sourceLabel, rainLabel, mm, monthName()).
   * `onSpeak` is called (with no args) when the 🔊 button is tapped —
   * speaking is on-tap only, never automatic, since this text is long.
   */
  function addCropResult(result, labels, onSpeak) {
    _hideWelcome();
    const msg = document.createElement("div");
    msg.className = "message bot";
    const body = document.createElement("div");
    body.className = "message-body";
    body.appendChild(_createLabel(labels.resultLabel));

    const bubble = document.createElement("div");
    bubble.className = "bubble crop-result";

    const speakRow = document.createElement("div");
    speakRow.className = "crop-result-speak-row";
    const speakBtn = document.createElement("button");
    speakBtn.className = "crop-result-speak-btn";
    speakBtn.type = "button";
    speakBtn.innerHTML = "🔊";
    speakBtn.title = labels.speakTitle;
    speakBtn.setAttribute("aria-label", labels.speakTitle);
    speakBtn.addEventListener("click", () => {
      if (onSpeak) onSpeak(speakBtn);
    });
    speakRow.appendChild(speakBtn);
    bubble.appendChild(speakRow);

    (result.crops || []).forEach((crop) => {
      const item = document.createElement("div");
      item.className = "crop-result-item";

      const nameEl = document.createElement("div");
      nameEl.className = "crop-result-name";
      nameEl.textContent = crop.name;
      item.appendChild(nameEl);

      if (Array.isArray(crop.sowing_months) && crop.sowing_months.length > 0) {
        const monthsEl = document.createElement("div");
        monthsEl.className = "crop-result-months";
        monthsEl.textContent = crop.sowing_months.map(labels.monthName).join(", ");
        item.appendChild(monthsEl);
      }

      if (crop.reason) {
        const reasonEl = document.createElement("div");
        reasonEl.className = "crop-result-reason";
        reasonEl.textContent = crop.reason;
        item.appendChild(reasonEl);
      }

      if (crop.risk) {
        const riskEl = document.createElement("div");
        riskEl.className = "crop-result-risk";
        const riskLabel = document.createElement("span");
        riskLabel.className = "crop-result-risk-label";
        riskLabel.textContent = labels.riskLabel + ": ";
        riskEl.appendChild(riskLabel);
        riskEl.appendChild(document.createTextNode(crop.risk));
        item.appendChild(riskEl);
      }

      if (Array.isArray(crop.evidence_refs) && crop.evidence_refs.length > 0) {
        const sourceEl = document.createElement("div");
        sourceEl.className = "crop-result-source";
        const refs = crop.evidence_refs
          .map((r) => `p${r.page}${r.section ? " sec " + r.section : ""}`)
          .join(", ");
        sourceEl.textContent = `${labels.sourceLabel}: ICAR 2011, ${refs}`;
        item.appendChild(sourceEl);
      }

      bubble.appendChild(item);
    });

    if (result.weather && typeof result.weather.rain_last_14_days_mm === "number") {
      const weatherEl = document.createElement("div");
      weatherEl.className = "crop-result-weather";
      weatherEl.textContent = `${labels.rainLabel}: ${result.weather.rain_last_14_days_mm} ${labels.mm}`;
      bubble.appendChild(weatherEl);
    }

    if (result.disclaimer) {
      const disclaimerEl = document.createElement("div");
      disclaimerEl.className = "crop-result-disclaimer";
      disclaimerEl.textContent = result.disclaimer;
      bubble.appendChild(disclaimerEl);
    }

    body.appendChild(bubble);
    msg.appendChild(_createAvatar("bot"));
    msg.appendChild(body);
    _chatArea.appendChild(msg);
    _scrollToBottom();
    return { msg, speakBtn };
  }

  function _formatTime(seconds) {
    if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  return {
    init,
    addSpeechResult,
    addBotText,
    addUserText,
    addTypingBubble,
    addTTSResult,
    addUserPhoto,
    addDiseaseLoading,
    addDiseaseResult,
    addCropResult,
    addError,
  };
})();


/* ─── Settings Modal ─────────────────────────────────────── */
const Settings = (() => {
  let _modal, _overlay;
  const VOICES = ["Sunita", "Sanjay", "Nikhil", "Radha", "Varun", "Isha"];
  let _selectedVoice = Config.get("voice");

  function init() {
    _overlay = document.getElementById("settings-overlay");
    _modal = document.getElementById("settings-modal");

    // Build voice grid
    const voiceGrid = document.getElementById("voice-grid");
    VOICES.forEach((voice) => {
      const btn = document.createElement("button");
      btn.className = `voice-btn${voice === _selectedVoice ? " selected" : ""}`;
      btn.textContent = voice;
      btn.dataset.voice = voice;
      btn.addEventListener("click", () => {
        voiceGrid.querySelectorAll(".voice-btn").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        _selectedVoice = voice;
      });
      voiceGrid.appendChild(btn);
    });

    // Load saved values
    document.getElementById("api-url-input").value = Config.get("apiUrl");

    // Save button
    document.getElementById("settings-save").addEventListener("click", () => {
      const apiUrl = document.getElementById("api-url-input").value.trim();
      Config.save({ apiUrl, voice: _selectedVoice });
      close();
      Toast.show(`Settings saved! Voice: ${_selectedVoice}`, "success");
    });

    // Close
    document.getElementById("settings-close").addEventListener("click", close);
    _overlay.addEventListener("click", (e) => {
      if (e.target === _overlay) close();
    });
  }

  function open() {
    _overlay.classList.add("open");
    document.getElementById("api-url-input").value = Config.get("apiUrl");
  }

  function close() {
    _overlay.classList.remove("open");
  }

  return { init, open, close };
})();


/* ─── Crop Picker Modal (leaf disease check) ─────────────── */
const CropPicker = (() => {
  let _overlay;
  let _selectedCrop = null;
  const CROPS = [
    { name: "Cotton", icon: "🌱" },
    { name: "Grape", icon: "🍇" },
    { name: "Maize", icon: "🌽" },
    { name: "Onion", icon: "🧅" },
    { name: "Tomato", icon: "🍅" },
  ];

  function init(onCropChosen) {
    _overlay = document.getElementById("crop-overlay");

    const cropGrid = document.getElementById("crop-grid");
    CROPS.forEach(({ name, icon }) => {
      const btn = document.createElement("button");
      btn.className = "crop-btn";
      btn.dataset.crop = name;
      btn.innerHTML = `<span class="crop-icon" aria-hidden="true">${icon}</span><span>${name}</span>`;
      btn.addEventListener("click", () => {
        _selectedCrop = name;
        close();
        if (onCropChosen) onCropChosen(name);
      });
      cropGrid.appendChild(btn);
    });

    document.getElementById("crop-close").addEventListener("click", close);
    _overlay.addEventListener("click", (e) => {
      if (e.target === _overlay) close();
    });
  }

  function open() {
    _overlay.classList.add("open");
  }

  function close() {
    _overlay.classList.remove("open");
  }

  function getSelectedCrop() { return _selectedCrop; }

  return { init, open, close, getSelectedCrop };
})();


/* ─── Crop Advisor i18n (Module 2 Phase 5) ───────────────────
   The app has no other UI-string localization yet (LanguageSelector only
   picks the backend's reply language) — this is the first one, built
   fresh for the Crop Advisor form and result card. reviewed:false: a
   first-pass mr/hi translation, not checked by a native speaker/KVK yet
   (same convention as backend/data/crop_messages.json). ─────────────── */
const CropI18n = (() => {
  const STRINGS = {
    buttonLabel:  { mr: "पीक सल्ला", hi: "फसल सलाह", en: "Crop Advisor" },
    modalTitle:   { mr: "🌾 पीक सल्ला", hi: "🌾 फसल सलाह", en: "🌾 Crop Advisor" },
    taluka:       { mr: "तालुका", hi: "तालुका", en: "Taluka" },
    sowingMonth:  { mr: "पेरणीचा महिना", hi: "बुवाई का महीना", en: "Sowing month" },
    irrigation:   { mr: "पाण्याची सुविधा आहे का?", hi: "सिंचाई की सुविधा है?", en: "Irrigation available?" },
    yes:          { mr: "हो", hi: "हाँ", en: "Yes" },
    no:           { mr: "नाही", hi: "नहीं", en: "No" },
    soilType:     { mr: "जमिनीचा प्रकार", hi: "मिट्टी का प्रकार", en: "Soil type" },
    previousCrop: { mr: "मागील पीक", hi: "पिछली फसल", en: "Previous crop" },
    none:         { mr: "काहीही नाही", hi: "कोई नहीं", en: "None" },
    notSure:      { mr: "माहीत नाही", hi: "पता नहीं", en: "Not sure" },
    soilCard:     { mr: "माती आरोग्य पत्रिका मूल्ये (पर्यायी)", hi: "मृदा स्वास्थ्य कार्ड मूल्य (वैकल्पिक)", en: "Soil Health Card values (optional)" },
    ph:           { mr: "pH", hi: "pH", en: "pH" },
    ec:           { mr: "EC (dS/m)", hi: "EC (dS/m)", en: "EC (dS/m)" },
    oc:           { mr: "OC (%)", hi: "OC (%)", en: "OC (%)" },
    n:            { mr: "N (kg/ha)", hi: "N (kg/ha)", en: "N (kg/ha)" },
    p:            { mr: "P (kg/ha)", hi: "P (kg/ha)", en: "P (kg/ha)" },
    k:            { mr: "K (kg/ha)", hi: "K (kg/ha)", en: "K (kg/ha)" },
    submit:       { mr: "पीक सल्ला मिळवा", hi: "फसल सलाह पाएं", en: "Get crop advice" },
    loading:      { mr: "पीक सल्ला तयार होत आहे…", hi: "फसल सलाह तैयार हो रही है…", en: "Preparing crop advice…" },
    timeoutError: { mr: "सध्या उत्तर मिळत नाही. कृपया पुन्हा प्रयत्न करा.", hi: "अभी जवाब नहीं मिल रहा है। कृपया फिर से प्रयास करें.", en: "This is taking too long. Please try again." },
    optionsError: { mr: "फॉर्मसाठी माहिती मिळाली नाही. कृपया नंतर प्रयत्न करा.", hi: "फ़ॉर्म के लिए जानकारी नहीं मिली। कृपया बाद में प्रयास करें.", en: "Could not load the form. Please try again later." },
    resultLabel:  { mr: "🌾 पीक सल्ला निकाल", hi: "🌾 फसल सलाह परिणाम", en: "🌾 Crop Advisor Result" },
    riskLabel:    { mr: "धोका", hi: "जोखिम", en: "Risk" },
    sourceLabel:  { mr: "स्रोत", hi: "स्रोत", en: "Source" },
    rainLabel:    { mr: "गेल्या १४ दिवसांतील पाऊस", hi: "पिछले 14 दिनों की बारिश", en: "Rain in the last 14 days" },
    mm:           { mr: "मिमी", hi: "मिमी", en: "mm" },
    speakTitle:   { mr: "ऐकण्यासाठी दाबा", hi: "सुनने के लिए दबाएँ", en: "Tap to hear this" },
  };

  const MONTHS = {
    mr: ["जानेवारी", "फेब्रुवारी", "मार्च", "एप्रिल", "मे", "जून", "जुलै", "ऑगस्ट", "सप्टेंबर", "ऑक्टोबर", "नोव्हेंबर", "डिसेंबर"],
    hi: ["जनवरी", "फरवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"],
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  };

  function t(key, lang) {
    const entry = STRINGS[key];
    if (!entry) return key;
    return entry[lang] || entry.en || key;
  }

  function monthName(monthNum, lang) {
    const arr = MONTHS[lang] || MONTHS.en;
    return arr[monthNum - 1] || String(monthNum);
  }

  // A snapshot of every label for one language, so call sites (e.g.
  // ChatUI.addCropResult) don't each need to know the current language.
  function getLabels(lang) {
    const labels = {};
    Object.keys(STRINGS).forEach((key) => { labels[key] = t(key, lang); });
    labels.monthName = (monthNum) => monthName(monthNum, lang);
    return labels;
  }

  return { t, monthName, getLabels };
})();


/* ─── Crop Advisor Modal (Module 2 Phase 5) ──────────────────
   Form UI only (open/close/populate/read) — API calls and chat rendering
   are orchestrated by App, same split as CropPicker/DiseaseCheck. ───── */
const CropAdvisorModal = (() => {
  let _overlay, _talukaSelect, _monthSelect, _soilTypeSelect, _prevCropSelect;
  let _irrigationGroup, _submitBtn;
  let _onSubmit = null;
  let _options = null; // cached {talukas, soil_types, crops} from API.cropOptions()
  let _irrigationValue = "yes";

  function _localized(entry, lang) {
    return (entry && (entry[lang] || entry.en)) || "";
  }

  function _populateSelect(select, items, { valueKey, labelFn, includeNone = false, noneLabel = "" }) {
    const previous = select.value;
    select.innerHTML = "";
    if (includeNone) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = noneLabel;
      select.appendChild(opt);
    }
    items.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = valueKey(item);
      opt.textContent = labelFn(item);
      select.appendChild(opt);
    });
    if (previous) select.value = previous;
  }

  function _populateMonths(lang) {
    const previous = _monthSelect.value;
    _monthSelect.innerHTML = "";
    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement("option");
      opt.value = String(m);
      opt.textContent = CropI18n.monthName(m, lang);
      _monthSelect.appendChild(opt);
    }
    // Default to the current month the first time; keep the farmer's
    // choice on later language switches.
    _monthSelect.value = previous || String(new Date().getMonth() + 1);
  }

  function _populateOptions(options, lang) {
    const labels = CropI18n.getLabels(lang);
    _populateSelect(_talukaSelect, options.talukas || [], {
      valueKey: (t) => t.en, // crop_api matches talukas by English name
      labelFn: (t) => _localized(t, lang),
    });
    _populateSelect(_soilTypeSelect, options.soil_types || [], {
      valueKey: (s) => s.id,
      labelFn: (s) => _localized(s, lang),
      includeNone: true,
      noneLabel: labels.notSure,
    });
    _populateSelect(_prevCropSelect, options.crops || [], {
      valueKey: (c) => c.id,
      labelFn: (c) => _localized(c.names, lang),
      includeNone: true,
      noneLabel: labels.none,
    });
    _populateMonths(lang);
  }

  function _applyIrrigationSelection() {
    _irrigationGroup.querySelectorAll(".toggle-btn").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.value === _irrigationValue);
    });
  }

  function applyLanguage() {
    const lang = LanguageSelector.getLanguage();
    const labels = CropI18n.getLabels(lang);
    document.getElementById("crop-advisor-modal-title").textContent = labels.modalTitle;
    document.getElementById("crop-advisor-taluka-label").textContent = labels.taluka;
    document.getElementById("crop-advisor-month-label").textContent = labels.sowingMonth;
    document.getElementById("crop-advisor-irrigation-label").textContent = labels.irrigation;
    document.getElementById("crop-advisor-soiltype-label").textContent = labels.soilType;
    document.getElementById("crop-advisor-prevcrop-label").textContent = labels.previousCrop;
    document.getElementById("crop-advisor-soilcard-label").textContent = labels.soilCard;
    document.getElementById("crop-advisor-ph-label").textContent = labels.ph;
    document.getElementById("crop-advisor-ec-label").textContent = labels.ec;
    document.getElementById("crop-advisor-oc-label").textContent = labels.oc;
    document.getElementById("crop-advisor-n-label").textContent = labels.n;
    document.getElementById("crop-advisor-p-label").textContent = labels.p;
    document.getElementById("crop-advisor-k-label").textContent = labels.k;
    _submitBtn.textContent = labels.submit;
    _irrigationGroup.querySelector('[data-value="yes"]').textContent = labels.yes;
    _irrigationGroup.querySelector('[data-value="no"]').textContent = labels.no;

    if (_options) _populateOptions(_options, lang);
  }

  function init(onSubmit) {
    _onSubmit = onSubmit;
    _overlay = document.getElementById("crop-advisor-overlay");
    _talukaSelect = document.getElementById("crop-advisor-taluka");
    _monthSelect = document.getElementById("crop-advisor-month");
    _soilTypeSelect = document.getElementById("crop-advisor-soiltype");
    _prevCropSelect = document.getElementById("crop-advisor-prevcrop");
    _irrigationGroup = document.getElementById("crop-advisor-irrigation");
    _submitBtn = document.getElementById("crop-advisor-submit");

    document.getElementById("crop-advisor-close").addEventListener("click", close);
    _overlay.addEventListener("click", (e) => {
      if (e.target === _overlay) close();
    });

    _irrigationGroup.querySelectorAll(".toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        _irrigationValue = btn.dataset.value;
        _applyIrrigationSelection();
      });
    });
    _applyIrrigationSelection();

    _submitBtn.addEventListener("click", () => {
      if (_onSubmit) _onSubmit(_readForm());
    });

    applyLanguage();
  }

  function open(options) {
    _options = options;
    _irrigationValue = "yes";
    _applyIrrigationSelection();
    applyLanguage();
    _overlay.classList.add("open");
  }

  function close() {
    _overlay.classList.remove("open");
  }

  function setSubmitEnabled(enabled) {
    _submitBtn.disabled = !enabled;
  }

  function _numberOrUndefined(id) {
    const val = document.getElementById(id).value.trim();
    return val === "" ? undefined : Number(val);
  }

  function _readForm() {
    return {
      taluka: _talukaSelect.value,
      sowing_month: Number(_monthSelect.value),
      irrigation: _irrigationValue,
      previous_crop: _prevCropSelect.value || null,
      soil_type: _soilTypeSelect.value || null,
      soil: {
        ph: _numberOrUndefined("crop-advisor-ph"),
        ec: _numberOrUndefined("crop-advisor-ec"),
        oc: _numberOrUndefined("crop-advisor-oc"),
        n: _numberOrUndefined("crop-advisor-n"),
        p: _numberOrUndefined("crop-advisor-p"),
        k: _numberOrUndefined("crop-advisor-k"),
      },
    };
  }

  return { init, open, close, applyLanguage, setSubmitEnabled };
})();


/* ─── App ─────────────────────────────────────────────────── */
const App = (() => {
  let _micBtn, _micLabel;
  let _textInput, _sendBtn;
  let _transcriptEl;
  let _photoBtn, _photoInput;
  let _cropAdvisorBtn, _cropAdvisorLabel;
  let _pendingCrop = null;
  let _isProcessing = false;
  let _interimText = "";
  let _finalLiveText = "";
  let _cropOptionsCache = null;

  function init() {
    // DOM refs
    _micBtn = document.getElementById("mic-btn");
    _micLabel = document.getElementById("mic-label");
    _textInput = document.getElementById("text-input");
    _sendBtn = document.getElementById("send-btn");
    _transcriptEl = document.getElementById("input-transcript");
    _photoBtn = document.getElementById("photo-btn");
    _photoInput = document.getElementById("photo-input");
    _cropAdvisorBtn = document.getElementById("crop-advisor-btn");
    _cropAdvisorLabel = document.getElementById("crop-advisor-label");

    const chatArea = document.getElementById("chat-area");
    const welcomeScreen = document.getElementById("welcome-screen");

    ChatUI.init(chatArea, welcomeScreen);
    LanguageSelector.init();
    Settings.init();
    ChatHistory.init();
    CropPicker.init((crop) => {
      _pendingCrop = crop;
      _photoInput.click();
    });
    CropAdvisorModal.init((formData) => _handleCropAdvisorSubmit(formData));

    // Re-localize the Crop Advisor button + modal whenever the farmer
    // switches language (the rest of the app's UI text doesn't localize
    // today, but the Crop Advisor's labels are built to, from the start).
    LanguageSelector.onChange(() => {
      _updateCropAdvisorButtonLabel();
      CropAdvisorModal.applyLanguage();
    });
    _updateCropAdvisorButtonLabel();

    // Settings button
    document.getElementById("settings-btn").addEventListener("click", Settings.open);

    // Mic button
    _micBtn.addEventListener("click", _toggleMic);

    // Photo button (leaf disease check)
    _photoBtn.addEventListener("click", CropPicker.open);
    _photoInput.addEventListener("change", () => {
      const file = _photoInput.files && _photoInput.files[0];
      const crop = _pendingCrop;
      _photoInput.value = ""; // allow picking the same file again next time
      if (file && crop) {
        _handlePhotoUpload(file, crop);
      }
    });

    // Crop Advisor button
    _cropAdvisorBtn.addEventListener("click", _openCropAdvisor);

    // Text input
    _textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        _sendText();
      }
    });
    _textInput.addEventListener("input", _autoResize);
    _sendBtn.addEventListener("click", _sendText);

    // Check backend health
    _checkHealth();

    // PWA install prompt
    _setupInstallPrompt();

    // Register service worker
    _registerSW();
  }

  // ── Mic: toggle recording ────────────────────────────────
  let _micStarting = false;

  async function _toggleMic() {
    if (_isProcessing || _micStarting) return;

    if (SpeechInput.isRecording()) {
      // Stop recording
      SpeechInput.stopRecording();
      _micBtn.classList.remove("recording");
      _micBtn.classList.add("processing");
      _setMicLabel("Processing...");
      _isProcessing = true;
      return;
    }

    // Start recording
    _micStarting = true;
    _micBtn.classList.add("recording");
    _setMicLabel("Tap to stop...");
    _interimText = "";
    _finalLiveText = "";
    _showTranscript("");

    const stream = await SpeechInput.startRecording({
      onInterim: (text, finalPart, interimPart) => {
        _finalLiveText = finalPart;
        _interimText = interimPart;
        _showTranscript(finalPart, interimPart);
      },
      onFinal: (audioBlob) => {
        _processSpeech(audioBlob);
      },
      onError: (msg) => {
        _micBtn.classList.remove("recording");
        _setMicLabel("Tap to speak");
        _hideTranscript();
        Toast.show(msg, "error");
        _isProcessing = false;
        _micStarting = false;
      },
    });

    if (!stream) {
      _micBtn.classList.remove("recording");
      _setMicLabel("Tap to speak");
    }

    _micStarting = false;
  }

  // ── Process speech audio blob → API ────────────────────
  async function _processSpeech(audioBlob) {
    if (audioBlob.size < 1000) {
      // Too small — probably no speech
      _micBtn.classList.remove("processing");
      _setMicLabel("Tap to speak");
      _hideTranscript();
      _isProcessing = false;
      Toast.show("No speech detected. Try again!", "info");
      return;
    }

    const typingEl = ChatUI.addTypingBubble();

    try {
      const result = await API.speechToText(audioBlob);
      typingEl.remove();
      _hideTranscript();

      if (result.marathi_text) {
        ChatUI.addSpeechResult(result.marathi_text, result.english_text);

        // Start the LLM call right away; saving history runs alongside it
        const aiTypingEl = ChatUI.addTypingBubble();
        const chatPromise = API.chat(result.marathi_text);
        const historyReady = ChatHistory.ensureChatId(result.marathi_text.substring(0, 30) || "Speech Chat")
          .then(() => API.saveMessage(ChatHistory.getChatId(), "user", "speech_result", {
            marathi_text: result.marathi_text,
            english_text: result.english_text
          }));
        try {
          const chatResult = await chatPromise;
          const aiResponseText = chatResult.response;
          aiTypingEl.remove();

          const ttsLanguage = chatResult.translation_failed ? "en" : LanguageSelector.getLanguage();
          let ttsResult = null;
          try {
            ttsResult = await API.textToSpeech(aiResponseText, Config.get("voice"), ttsLanguage);
          } catch (ttsErr) {
            console.warn("TTS failed, showing text only:", ttsErr);
          }

          if (ttsResult) {
            ChatUI.addTTSResult(
              ttsResult.marathi_text,
              ttsResult.word_timings,
              ttsResult.audio_base64,
              ttsResult.voice || Config.get("voice"),
              ttsResult.duration || 3,
            );
          } else {
            ChatUI.addBotText("Voice not available", aiResponseText);
          }

          await historyReady;
          if (ttsResult) {
            await API.saveMessage(ChatHistory.getChatId(), "bot", "bot_tts", {
              ai_response: aiResponseText,
              reply_language: LanguageSelector.getLanguage(),
              marathi_text: ttsResult.marathi_text,
              word_timings: ttsResult.word_timings,
              audio_base64: ttsResult.audio_base64,
              voice: ttsResult.voice || Config.get("voice"),
              duration: ttsResult.duration || 3
            });
          } else {
            await API.saveMessage(ChatHistory.getChatId(), "bot", "bot_text", {
              ai_response: aiResponseText,
              reply_language: LanguageSelector.getLanguage(),
            });
          }
        } catch (err) {
          aiTypingEl.remove();
          ChatUI.addError("AI Error: " + err.message);
        }
      } else {
        ChatUI.addError("No speech detected. Please try again.");
      }
    } catch (err) {
      typingEl.remove();
      _hideTranscript();
      ChatUI.addError(err.message || "Speech recognition failed.");
      Toast.show("Error: " + err.message, "error");
    } finally {
      _micBtn.classList.remove("processing");
      _setMicLabel("Tap to speak");
      _isProcessing = false;
    }
  }

  // ── Leaf photo upload → disease check ───────────────────
  async function _handlePhotoUpload(file, crop) {
    if (_isProcessing) return;
    _isProcessing = true;

    const thumbnailUrl = URL.createObjectURL(file);
    ChatUI.addUserPhoto(thumbnailUrl, crop);
    const loadingEl = ChatUI.addDiseaseLoading("Checking your leaf...");

    try {
      const result = await DiseaseCheck.checkDisease(file, crop);
      loadingEl.remove();
      ChatUI.addDiseaseResult(result);
      await _speakDiseaseMessage(result);
    } catch (err) {
      loadingEl.remove();
      ChatUI.addError(_friendlyDiseaseError(err));
    } finally {
      _isProcessing = false;
    }
  }

  // ── Speak only the result message (no percentages) ─────
  async function _speakDiseaseMessage(result) {
    try {
      const ttsResult = await API.textToSpeech(result.message, Config.get("voice"));

      ChatUI.addTTSResult(
        ttsResult.marathi_text,
        ttsResult.word_timings,
        ttsResult.audio_base64,
        ttsResult.voice || Config.get("voice"),
        ttsResult.duration || 3,
      );
    } catch (err) {
      console.warn("Could not speak disease result:", err);
    }
  }

  // ── Turn a disease-check error into a farmer-friendly message ──
  function _friendlyDiseaseError(err) {
    const status = err.status;
    const raw = err.message || "";

    if (status === 413) {
      return "That photo is too large. Please use a smaller photo (under 10 MB) and try again.";
    }
    if (status === 400 && /readable image|JPG or PNG/i.test(raw)) {
      return "That file doesn't look like a photo. Please upload a JPG or PNG image.";
    }
    if (status === 503) {
      return "The leaf-check service isn't reachable right now. Please make sure it's running and try again.";
    }
    return raw || "Something went wrong while checking the leaf. Please try again.";
  }

  // ── Crop Advisor: button + modal → /api/crop ────────────
  function _updateCropAdvisorButtonLabel() {
    const label = CropI18n.t("buttonLabel", LanguageSelector.getLanguage());
    _cropAdvisorBtn.title = label;
    _cropAdvisorBtn.setAttribute("aria-label", label);
    _cropAdvisorLabel.textContent = label;
  }

  async function _openCropAdvisor() {
    if (_isProcessing) return;
    const lang = LanguageSelector.getLanguage();
    try {
      if (!_cropOptionsCache) {
        _cropOptionsCache = await API.cropOptions();
      }
      CropAdvisorModal.open(_cropOptionsCache);
    } catch (err) {
      console.warn("Could not load crop advisor options:", err);
      ChatUI.addError(CropI18n.t("optionsError", lang));
    }
  }

  async function _handleCropAdvisorSubmit(formData) {
    if (_isProcessing) return;
    _isProcessing = true;
    CropAdvisorModal.setSubmitEnabled(false);
    CropAdvisorModal.close();

    const lang = LanguageSelector.getLanguage();
    const labels = CropI18n.getLabels(lang);
    const loadingEl = ChatUI.addDiseaseLoading(labels.loading);

    try {
      const result = await API.cropAdvice({ ...formData, language: lang });
      loadingEl.remove();
      if (Array.isArray(result.crops) && result.crops.length > 0) {
        ChatUI.addCropResult(result, labels, (speakBtn) => _speakCropAdvice(result, lang, speakBtn));
      } else {
        // service_down/no_crops/400 all land here as a normal message —
        // result.message (or disclaimer alone) is already in the farmer's language.
        const text = [result.message, result.disclaimer].filter(Boolean).join("\n\n");
        ChatUI.addBotText(labels.resultLabel, text || labels.timeoutError);
      }
    } catch (err) {
      loadingEl.remove();
      ChatUI.addError(_friendlyCropError(err, lang));
    } finally {
      _isProcessing = false;
      CropAdvisorModal.setSubmitEnabled(true);
    }
  }

  // ── Speak only names/reason/risk/disclaimer — not source/evidence —
  //    and only when the farmer taps 🔊 (this text is long, unlike the
  //    short disease message, so it is never spoken automatically) ────
  function _buildCropSpokenText(result) {
    const parts = [];
    (result.crops || []).forEach((crop) => {
      if (crop.name) parts.push(crop.name);
      if (crop.reason) parts.push(crop.reason);
      if (crop.risk) parts.push(crop.risk);
    });
    if (result.disclaimer) parts.push(result.disclaimer);
    return _joinSpokenParts(parts);
  }

  // Each part (reason/risk/disclaimer) from the backend already ends with
  // its own full stop ("." or the Devanagari "।"), so a plain
  // parts.join(". ") produces a double stop ("A.. B."). Strip each part's
  // trailing stop before joining, then add exactly one back at the end.
  function _joinSpokenParts(parts) {
    const cleaned = parts
      .map((p) => (p || "").trim().replace(/[.।]+$/, "").trim())
      .filter(Boolean);
    return cleaned.length ? `${cleaned.join(". ")}.` : "";
  }

  async function _speakCropAdvice(result, language, speakBtn) {
    const text = _buildCropSpokenText(result);
    if (!text) return;

    speakBtn.disabled = true;
    speakBtn.classList.add("playing");
    try {
      const ttsResult = await API.textToSpeech(text, Config.get("voice"), language);
      ChatUI.addTTSResult(
        ttsResult.marathi_text,
        ttsResult.word_timings,
        ttsResult.audio_base64,
        ttsResult.voice || Config.get("voice"),
        ttsResult.duration || 3,
      );
    } catch (err) {
      // Voice failed — the card's text is already showing, so just log it.
      console.warn("Could not speak crop advice:", err);
    } finally {
      speakBtn.disabled = false;
      speakBtn.classList.remove("playing");
    }
  }

  // ── Turn a /api/crop error into a farmer-friendly message ──────────
  function _friendlyCropError(err, lang) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return CropI18n.t("timeoutError", lang);
    }
    return (err && err.message) || CropI18n.t("timeoutError", lang);
  }

  // ── Send English text → API ─────────────────────────────
  async function _sendText() {
    const text = _textInput.value.trim();
    if (!text || _isProcessing) return;

    _isProcessing = true;
    _textInput.value = "";
    _autoResize();
    _sendBtn.disabled = true;

    ChatUI.addUserText(text);
    const typingEl = ChatUI.addTypingBubble();

    try {
      // Start the LLM call right away; saving history runs alongside it
      const chatPromise = API.chat(text);
      const historyReady = ChatHistory.ensureChatId(text.substring(0, 30))
        .then(() => API.saveMessage(ChatHistory.getChatId(), "user", "user_text", {
          english_text: text
        }));

      const chatResult = await chatPromise;
      const aiResponseText = chatResult.response;
      typingEl.remove();

      const ttsLanguage = chatResult.translation_failed ? "en" : LanguageSelector.getLanguage();
      let result = null;
      try {
        result = await API.textToSpeech(aiResponseText, Config.get("voice"), ttsLanguage);
      } catch (ttsErr) {
        console.warn("TTS failed, showing text only:", ttsErr);
      }

      if (result) {
        ChatUI.addTTSResult(
          result.marathi_text,
          result.word_timings,
          result.audio_base64,
          result.voice || Config.get("voice"),
          result.duration || 3,
        );
      } else {
        ChatUI.addBotText("Voice not available", aiResponseText);
      }

      await historyReady;
      if (result) {
        await API.saveMessage(ChatHistory.getChatId(), "bot", "bot_tts", {
          ai_response: aiResponseText,
          reply_language: LanguageSelector.getLanguage(),
          marathi_text: result.marathi_text,
          word_timings: result.word_timings,
          audio_base64: result.audio_base64,
          voice: result.voice || Config.get("voice"),
          duration: result.duration || 3
        });
      } else {
        await API.saveMessage(ChatHistory.getChatId(), "bot", "bot_text", {
          ai_response: aiResponseText,
          reply_language: LanguageSelector.getLanguage(),
        });
      }
    } catch (err) {
      typingEl.remove();
      ChatUI.addError(err.message || "Request failed.");
      Toast.show("Error: " + err.message, "error");
    } finally {
      _isProcessing = false;
      _sendBtn.disabled = false;
    }
  }

  // ── UI helpers ──────────────────────────────────────────
  function _setMicLabel(text) {
    if (_micLabel) _micLabel.textContent = text;
  }

  function _showTranscript(finalText, interimText = "") {
    _transcriptEl.classList.add("visible");
    _transcriptEl.innerHTML = "";
    if (finalText) {
      const finalSpan = document.createElement("span");
      finalSpan.textContent = finalText;
      _transcriptEl.appendChild(finalSpan);
    }
    if (interimText) {
      const interim = document.createElement("span");
      interim.className = "interim";
      interim.textContent = (finalText ? " " : "") + interimText;
      _transcriptEl.appendChild(interim);
    }
    if (!finalText && !interimText) {
      const ph = document.createElement("span");
      ph.className = "live-placeholder";
      ph.textContent = "बोलत आहे... (Listening...)";
      _transcriptEl.appendChild(ph);
    }
  }

  function _hideTranscript() {
    _transcriptEl.classList.remove("visible");
    _transcriptEl.innerHTML = "";
  }

  function _autoResize() {
    _textInput.style.height = "auto";
    _textInput.style.height = Math.min(_textInput.scrollHeight, 140) + "px";
  }

  // ── Backend health check ────────────────────────────────
  async function _checkHealth() {
    const indicator = document.getElementById("status-indicator");
    const statusText = document.getElementById("status-text");

    try {
      const health = await API.healthCheck();
      indicator.classList.add("connected");
      indicator.classList.remove("error");
      statusText.textContent = `Connected · ${health.inference_mode}`;
    } catch {
      indicator.classList.remove("connected");
      indicator.classList.add("error");
      statusText.textContent = "Backend offline";
      Toast.show(
        "⚠️ Backend not reachable. Start the server at " + Config.get("apiUrl"),
        "error",
        6000
      );
    }
  }

  // ── PWA install prompt ──────────────────────────────────
  let _deferredPrompt = null;

  function _setupInstallPrompt() {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      _deferredPrompt = e;

      const prompt = document.createElement("div");
      prompt.className = "install-prompt";
      prompt.innerHTML = `
        <div class="install-text">
          <strong>📱 Install App</strong><br>
          Add Marathi Translator to your home screen
        </div>
        <button class="install-btn" id="install-btn">Install</button>
        <button class="install-dismiss" id="install-dismiss">✕</button>
      `;
      document.body.appendChild(prompt);

      document.getElementById("install-btn").addEventListener("click", async () => {
        _deferredPrompt.prompt();
        const { outcome } = await _deferredPrompt.userChoice;
        if (outcome === "accepted") {
          Toast.show("App installed! 🎉", "success");
        }
        prompt.remove();
        _deferredPrompt = null;
      });

      document.getElementById("install-dismiss").addEventListener("click", () => {
        prompt.remove();
      });
    });
  }

  // ── Service Worker registration ─────────────────────────
  function _registerSW() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch((err) => {
          console.warn("SW registration failed:", err);
        });
      });
    }
  }

  return { init };
})();


/* ─── Boot ────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  App.init();
  Toast.show("🙏 नमस्कार! Tap the mic to speak Marathi.", "info", 4000);
});
