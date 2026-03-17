FROM python:3.10-slim

ARG TTS_STT_PLAYGROUND_REPO=https://github.com/SteffenHebestreit/tts-stt-playground.git
ARG TTS_STT_PLAYGROUND_REF=master

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    git \
    espeak-ng \
    alsa-utils \
    pulseaudio \
    libsndfile1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN wget -O /tmp/piper.tar.gz https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_amd64.tar.gz \
    && tar -xzf /tmp/piper.tar.gz -C /opt/ \
    && rm /tmp/piper.tar.gz \
    && ln -s /opt/piper/piper /usr/local/bin/piper

WORKDIR /src

RUN git clone --depth 1 --branch "${TTS_STT_PLAYGROUND_REF}" "${TTS_STT_PLAYGROUND_REPO}" /src

WORKDIR /src/piper-tts-service

RUN pip install --no-cache-dir -r requirements.txt \
    && mkdir -p /app/models /app/output /app/voices \
    && mkdir -p /app/models/default \
    && cd /app/models/default \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json

ENV PYTHONUNBUFFERED=1 \
    PIPER_DATA_DIR=/app/models \
    PIPER_OUTPUT_DIR=/app/output

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:5000/health || exit 1

CMD ["python", "app.py"]