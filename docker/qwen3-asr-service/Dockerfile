FROM ubuntu:22.04

ARG TTS_STT_PLAYGROUND_REPO=https://github.com/SteffenHebestreit/tts-stt-playground.git
ARG TTS_STT_PLAYGROUND_REF=
# pytorch wheel index — override at build time:
#   cpu:   https://download.pytorch.org/whl/cpu      (default)
#   cuda:  https://download.pytorch.org/whl/cu121
#   rocm:  https://download.pytorch.org/whl/rocm6.2
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

ENV PYTHONUNBUFFERED=1 \
    QWEN3_ASR_MODEL=Qwen/Qwen3-ASR-1.7B

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
    && pip3 install --no-cache-dir torch torchaudio --index-url ${TORCH_INDEX_URL}

WORKDIR /src

RUN if [ -n "${TTS_STT_PLAYGROUND_REF}" ]; then \
        git clone --depth 1 --branch "${TTS_STT_PLAYGROUND_REF}" "${TTS_STT_PLAYGROUND_REPO}" /src; \
    else \
        git clone --depth 1 "${TTS_STT_PLAYGROUND_REPO}" /src; \
    fi

WORKDIR /src/qwen3-asr-service

RUN pip3 install --no-cache-dir -r requirements.txt

EXPOSE 5002

HEALTHCHECK --interval=30s --timeout=10s --start-period=900s --retries=3 \
    CMD curl -fsS http://localhost:5002/health || exit 1

CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5002"]
