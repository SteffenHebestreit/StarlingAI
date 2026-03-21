FROM ubuntu:22.04

# pytorch wheel index — override at build time:
#   cpu:   https://download.pytorch.org/whl/cpu      (default)
#   cuda:  https://download.pytorch.org/whl/cu121
#   rocm:  https://download.pytorch.org/whl/rocm6.2
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-dev \
    python3-pip \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python

RUN pip3 install --no-cache-dir --upgrade pip setuptools wheel \
    && pip3 install --no-cache-dir torch --index-url ${TORCH_INDEX_URL}

RUN pip3 install --no-cache-dir \
    "diffusers>=0.31.0" \
    "transformers>=4.51.3" \
    "accelerate>=0.30.0" \
    "safetensors>=0.4.3" \
    "sentencepiece>=0.2.0" \
    "Pillow>=10.3.0" \
    "fastapi>=0.111.0" \
    "uvicorn[standard]>=0.29.0" \
    "pydantic>=2.7.0"

WORKDIR /app

COPY docker/qwen-image-service/app.py /app/app.py

ENV PYTHONUNBUFFERED=1 \
    COMPUTE_BACKEND=cpu \
    IMAGE_MODEL=black-forest-labs/FLUX.1-schnell \
    IMAGE_CPU_OFFLOAD=true \
    UNIFIED_MEMORY=false

EXPOSE 5005

HEALTHCHECK --interval=30s --timeout=10s --start-period=900s --retries=3 \
    CMD curl -fsS http://localhost:5005/health || exit 1

CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5005"]
