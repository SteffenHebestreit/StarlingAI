FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ARG TTS_STT_PLAYGROUND_REPO=https://github.com/SteffenHebestreit/tts-stt-playground.git
ARG TTS_STT_PLAYGROUND_REF=main

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-dev \
    python3-pip \
    curl \
    git \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python

RUN pip3 install --no-cache-dir --upgrade pip setuptools wheel \
    && pip3 install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cu121 \
    && pip3 install --no-cache-dir flash-attn --no-build-isolation || echo "flash-attn not available, continuing without it"

WORKDIR /src

RUN git clone --depth 1 --branch "${TTS_STT_PLAYGROUND_REF}" "${TTS_STT_PLAYGROUND_REPO}" /src

WORKDIR /src/qwen3-tts-service

RUN pip3 install --no-cache-dir -r requirements.txt \
    && mkdir -p /app/voices

ENV PYTHONUNBUFFERED=1 \
    QWEN3_ASR_SERVICE_URL=http://qwen3-asr-service:5002 \
    QWEN3_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice \
    VOICES_DIR=/app/voices

EXPOSE 5004

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -fsS http://localhost:5004/health || exit 1

CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5004"]