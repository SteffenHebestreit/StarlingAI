# The Laya sidecar: fast local choice decisions (see app/server.py).
#
# torch comes from PyPI by default, whose Linux wheels carry CUDA and also run on the CPU. For a smaller CPU-only
# image build with --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
FROM python:3.12-slim-bookworm

ARG TORCH_INDEX_URL=
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # torch 2.14 otherwise JIT-compiles a kernel with a C compiler on the first request, which this image does not
    # have: every request would fail with 500 while /health stays green (laya issue #365).
    TORCH_DISABLE_NATIVE_JIT=1 \
    USE_TF=0 \
    TOKENIZERS_PARALLELISM=false \
    HF_HOME=/models/hf

RUN useradd --create-home --uid 10001 laya && mkdir -p /models/hf && chown -R laya /models

WORKDIR /srv
COPY requirements.txt .
RUN if [ -n "$TORCH_INDEX_URL" ]; then \
      pip install --no-cache-dir torch==2.14.0 --index-url "$TORCH_INDEX_URL"; \
    else \
      pip install --no-cache-dir torch==2.14.0; \
    fi \
 && pip install --no-cache-dir -r requirements.txt

COPY NOTICE ./
COPY app ./app
COPY tests ./tests

USER laya
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4).status == 200 else 1)"
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
