"""
Lightweight text-to-image generation service.

Wraps an open-source Stable Diffusion checkpoint as a FastAPI REST service.
Response: { "image": "<base64-png>", "width": int, "height": int, "seed": int,
            "backend": str, "device": str, "elapsed_ms": int }

────────────────────────────────────────────────────────────────────────────────
COMPUTE BACKEND SELECTION  (env: COMPUTE_BACKEND)
────────────────────────────────────────────────────────────────────────────────
  auto       Detect automatically: CUDA → ROCm → DirectML → CPU  (default)
  cuda       NVIDIA GPU via CUDA
  rocm       AMD GPU / APU via ROCm HIP (Linux + /dev/kfd required)
  directml   AMD / Intel / NVIDIA on Windows via DirectML (no driver needed)
  cpu        CPU-only inference (slow, float32)

  Note: Vulkan is a graphics API and is not supported for ML inference by
  PyTorch. DirectML is the correct Windows GPU compute path for AMD hardware.

────────────────────────────────────────────────────────────────────────────────
UNIFIED MEMORY (env: UNIFIED_MEMORY=true)
────────────────────────────────────────────────────────────────────────────────
  AMD Strix Halo / Ryzen AI Max series APUs have one large shared LPDDR5X pool
  for both CPU cores and the iGPU (up to 128 GB).  Setting UNIFIED_MEMORY=true
  disables CPU offloading and loads the model directly to the GPU device,
  because "CPU RAM" and "GPU VRAM" are the same physical memory — offloading
  would add unnecessary transfer overhead.

────────────────────────────────────────────────────────────────────────────────
ROCm / AMD TUNING (env vars)
────────────────────────────────────────────────────────────────────────────────
  HSA_OVERRIDE_GFX_VERSION    Force GFX version for ROCm driver compatibility.
                               gfx1151 Strix Halo (Ryzen AI Max / Max+): 11.5.1
                               gfx1150 Strix Point (Ryzen AI 300 series): 11.5.0
                               gfx1100 RX 7000 series (RDNA 3 dGPU):     11.0.0
                               Default: 11.5.1 (Strix Halo)
  PYTORCH_HIP_ALLOC_CONF      Default: expandable_segments:True
  HSA_ENABLE_SDMA             Disable DMA engine on APUs. Default: 0
  HSA_XNACK                   Enable page-migration on APUs. Default: 1
  HSA_FORCE_FINE_GRAIN_PCIE   Coherent host↔device on unified memory. Default: 1
  ROCBLAS_USE_HIPBLASLT       Use hipBLASLt for matmuls (~9%→62% efficiency
                               on gfx1151). Default: 1
"""

import os
from pathlib import Path

# ── ROCm / HIP environment must be configured BEFORE importing torch ──────────
_backend_env = os.getenv("COMPUTE_BACKEND", "auto").lower()

if _backend_env in ("rocm", "auto"):
    # GFX version override for RDNA 3 / 3.5 GPUs not yet in ROCm's official list.
    #   gfx1151 = Strix Halo (Ryzen AI Max / Max+, Radeon 8060S) → 11.5.1
    #   gfx1150 = Strix Point (Ryzen AI 300 series)               → 11.5.0
    #   gfx1100 = RX 7000 series (RDNA 3 dGPU)                    → 11.0.0
    # Note: 11.0.2 (sometimes cited) targets older RDNA 3 dGPUs and is wrong for APUs.
    os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "11.5.1")
    # Expandable memory segments prevent fragmentation on large unified pools.
    os.environ.setdefault("PYTORCH_HIP_ALLOC_CONF", "expandable_segments:True")
    # Disable SDMA DMA engine — avoids allocation failures on APU unified memory.
    os.environ.setdefault("HSA_ENABLE_SDMA", "0")
    # XNACK: enable page-migration / unified memory support on APUs.
    os.environ.setdefault("HSA_XNACK", "1")
    # Fine-grain PCIe: required for coherent host↔device access on unified memory.
    os.environ.setdefault("HSA_FORCE_FINE_GRAIN_PCIE", "1")
    # hipBLASLt dramatically improves matmul efficiency on gfx1151
    # (measured: ~9% → ~62% of theoretical peak on Strix Halo).
    os.environ.setdefault("ROCBLAS_USE_HIPBLASLT", "1")

# ─────────────────────────────────────────────────────────────────────────────

import base64
import io
import logging
import random
import threading
import time
from contextlib import suppress

import torch
from diffusers import DiffusionPipeline
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
)
log = logging.getLogger("image-generation-service")
# ── Configuration ─────────────────────────────────────────────────────────────
# Default to a fast Flux checkpoint. It is still substantially heavier than
# SD 1.5, but much faster than the larger Flux variants and aligns with the
# requested Flux-based backend.
MODEL_ID = os.getenv("IMAGE_MODEL", os.getenv("QWEN_IMAGE_MODEL", "black-forest-labs/FLUX.1-schnell"))
# Offload model layers to CPU when VRAM is constrained.
# Automatically disabled when UNIFIED_MEMORY=true (APU mode).
CPU_OFFLOAD = os.getenv("IMAGE_CPU_OFFLOAD", os.getenv("QWEN_IMAGE_CPU_OFFLOAD", "true")).lower() != "false"
# Unified memory: iGPU and CPU share the same physical memory pool.
# On Strix Halo / Ryzen AI Max, set UNIFIED_MEMORY=true to skip all offloading.
UNIFIED_MEMORY = os.getenv("UNIFIED_MEMORY", "false").lower() == "true"


# ── Backend detection ─────────────────────────────────────────────────────────
def _detect_backend() -> tuple[str, str]:
    """Return (backend_name, torch_device_string)."""
    if _backend_env == "cuda":
        return "cuda", "cuda"
    if _backend_env == "rocm":
        return "rocm", "cuda"   # ROCm uses the CUDA compatibility layer in PyTorch
    if _backend_env == "cpu":
        return "cpu", "cpu"
    if _backend_env == "directml":
        try:
            import torch_directml  # noqa: F401
            return "directml", "privateuseone"
        except ImportError:
            log.warning("torch-directml not installed; falling back to CPU")
            return "cpu", "cpu"

    # auto-detect: CUDA → ROCm → DirectML → CPU
    if torch.cuda.is_available():
        # ROCm builds expose torch.version.hip; CUDA builds do not.
        if getattr(torch.version, "hip", None):
            return "rocm", "cuda"
        return "cuda", "cuda"
    # DirectML: Windows AMD/Intel/NVIDIA via Windows ML (no /dev/kfd needed)
    try:
        import torch_directml  # noqa: F401
        if torch_directml.device_count() > 0:
            return "directml", "privateuseone"
    except Exception:
        pass
    return "cpu", "cpu"


BACKEND, DEVICE = _detect_backend()

# DirectML device handle (only used when BACKEND == "directml")
_directml_device = None
if BACKEND == "directml":
    with suppress(Exception):
        import torch_directml
        _directml_device = torch_directml.device()

_BACKEND_DTYPE: dict[str, torch.dtype] = {
    "cuda":     torch.bfloat16,  # BF16 is native on Ampere+ and ROCm RDNA3+
    "rocm":     torch.bfloat16,
    "directml": torch.float16,   # DML does not support BF16 in most cases
    "cpu":      torch.float32,   # BF16 inference is slow on most x86 CPUs
}
DTYPE = _BACKEND_DTYPE.get(BACKEND, torch.bfloat16)

log.info(
    "Backend: %s | device: %s | dtype: %s | unified_memory: %s | cpu_offload: %s",
    BACKEND, DEVICE, DTYPE, UNIFIED_MEMORY, CPU_OFFLOAD,
)

if BACKEND == "rocm":
    log.info(
        "ROCm tuning — GFX=%s  HIP_ALLOC=%s  XNACK=%s  FINE_GRAIN=%s  HIPBLASLT=%s",
        os.environ.get("HSA_OVERRIDE_GFX_VERSION"),
        os.environ.get("PYTORCH_HIP_ALLOC_CONF"),
        os.environ.get("HSA_XNACK"),
        os.environ.get("HSA_FORCE_FINE_GRAIN_PCIE"),
        os.environ.get("ROCBLAS_USE_HIPBLASLT"),
    )

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="image-generation-service", version="2.0.0")

# ── Model state ───────────────────────────────────────────────────────────────
pipe = None
model_ready = False
model_error: str | None = None
load_start: float = 0.0
_load_thread: threading.Thread | None = None
_load_lock = threading.Lock()


def _validate_backend_configuration() -> None:
    if _backend_env == "cuda":
        if not torch.cuda.is_available() or bool(getattr(torch.version, "hip", None)):
            raise RuntimeError(
                "COMPUTE_BACKEND=cuda requested but no NVIDIA CUDA device is available. "
                "Use the default CUDA image only on NVIDIA hosts with working Docker GPU passthrough."
            )
    if _backend_env == "rocm":
        if not bool(getattr(torch.version, "hip", None)):
            raise RuntimeError(
                "COMPUTE_BACKEND=rocm requested but this image was built with a non-ROCm PyTorch wheel. "
                "Rebuild with TORCH_INDEX_URL=https://download.pytorch.org/whl/rocm6.2."
            )
        if not torch.cuda.is_available():
            missing_devices: list[str] = []
            if not Path("/dev/kfd").exists():
                missing_devices.append("/dev/kfd")
            if not Path("/dev/dri").exists():
                missing_devices.append("/dev/dri")
            missing_suffix = ""
            if missing_devices:
                missing_suffix = f" Missing devices: {', '.join(missing_devices)}."
            raise RuntimeError(
                "COMPUTE_BACKEND=rocm requested but no ROCm/HIP device is available." + missing_suffix +
                " On Strix Halo WSL, install AMD Radeon Software for WSL with ROCm, ensure kernel >= 6.18.4, "
                "and pass /dev/kfd plus /dev/dri into the container."
            )


def _apply_pipeline_optimizations(p) -> None:
    """Apply backend-specific memory and speed optimizations to the pipeline."""

    if BACKEND == "cpu":
        # CPU: nothing special — model is already on CPU at float32.
        log.info("CPU backend: no GPU optimizations applied")
        return

    if UNIFIED_MEMORY:
        # APU / unified-memory: iGPU addresses the full system DRAM directly.
        # Loading the model to the GPU device is sufficient; no offloading needed.
        log.info(
            "Unified memory mode: loading model to %s — no CPU offloading", DEVICE
        )
        p.to(DEVICE)
        # Attention slicing reduces peak activation memory without moving weights.
        with suppress(Exception):
            p.enable_attention_slicing(1)
        return

    if CPU_OFFLOAD:
        # Discrete GPU / APU without UNIFIED_MEMORY: keep peak VRAM low by
        # streaming model layers from CPU RAM on demand.  Works on 12–16 GB cards.
        log.info("CPU offload enabled: streaming model layers as needed")
        p.enable_model_cpu_offload()
    else:
        # Full model fits in VRAM (24 GB+) — fastest path.
        log.info("Full model loaded to %s", DEVICE)
        if BACKEND == "directml" and _directml_device is not None:
            p.to(_directml_device)
        else:
            p.to(DEVICE)
        with suppress(Exception):
            p.enable_attention_slicing(1)

    # Flash Attention 2 / scaled-dot-product attention — try silently.
    # Skipped when offloading because the attention processor is bound per-device.
    if not CPU_OFFLOAD:
        with suppress(Exception):
            p.enable_xformers_memory_efficient_attention()
            log.info("xformers memory-efficient attention enabled")


def _load_model_sync() -> None:
    global pipe, model_ready, model_error, load_start
    load_start = time.time()
    model_ready = False
    model_error = None
    log.info("Loading %s (dtype=%s)…", MODEL_ID, DTYPE)
    try:
        _validate_backend_configuration()
        pipe = DiffusionPipeline.from_pretrained(MODEL_ID, torch_dtype=DTYPE)
        _apply_pipeline_optimizations(pipe)
        model_ready = True
        elapsed = time.time() - load_start
        log.info("Model ready in %.1f s", elapsed)
    except Exception as exc:  # noqa: BLE001
        model_error = str(exc)
        log.error("Failed to load model: %s", exc, exc_info=True)


def _ensure_background_model_load() -> None:
    global _load_thread
    with _load_lock:
        if _load_thread is not None and _load_thread.is_alive():
            return
        _load_thread = threading.Thread(target=_load_model_sync, name="model-loader", daemon=True)
        _load_thread.start()


@app.on_event("startup")
async def load_model() -> None:
    _ensure_background_model_load()


# ── Supported resolutions ─────────────────────────────────────────────────────
# Flux checkpoints also operate on multiples of 8. Keep a moderate default so
# generation stays practical while preserving noticeably better quality than
# the earlier SD 1.5 fallback.
DEFAULT_WIDTH  = 768
DEFAULT_HEIGHT = 768


def snap_to_supported(width: int, height: int) -> tuple[int, int]:
    """Snap image dimensions to the nearest multiple of 8 within the allowed range."""
    normalized_width = max(256, min(1024, int(round(width / 8) * 8)))
    normalized_height = max(256, min(1024, int(round(height / 8) * 8)))
    return normalized_width, normalized_height


# ── Pydantic models ───────────────────────────────────────────────────────────
class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str | None = None
    width:  int   = Field(default=DEFAULT_WIDTH,  ge=256, le=2048)
    height: int   = Field(default=DEFAULT_HEIGHT, ge=256, le=2048)
    num_inference_steps: int   = Field(default=4,  ge=1,  le=100)
    guidance_scale:      float = Field(default=0.0, ge=0.0, le=20.0)
    seed: int | None = None


class GenerateResponse(BaseModel):
    image:      str    # base64-encoded PNG
    width:      int
    height:     int
    seed:       int
    model:      str
    backend:    str
    device:     str
    elapsed_ms: int


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> JSONResponse:
    base = {
        "model":          MODEL_ID,
        "backend":        BACKEND,
        "device":         DEVICE,
        "dtype":          str(DTYPE),
        "unified_memory": UNIFIED_MEMORY,
        "cpu_offload":    CPU_OFFLOAD and not UNIFIED_MEMORY,
    }
    if model_ready:
        return JSONResponse({"status": "ok", **base})
    if model_error:
        return JSONResponse({"status": "error", "error": model_error, **base}, status_code=503)
    elapsed = time.time() - load_start if load_start else 0
    return JSONResponse({"status": "loading", "elapsed_s": round(elapsed, 1), **base}, status_code=503)


@app.get("/backends")
def list_backends() -> JSONResponse:
    """Return the detected backend and available alternatives."""
    cuda_available = torch.cuda.is_available()
    is_rocm = cuda_available and bool(getattr(torch.version, "hip", None))
    return JSONResponse({
        "active":        BACKEND,
        "device":        DEVICE,
        "cuda":          cuda_available and not is_rocm,
        "rocm":          is_rocm,
        "cpu":           True,
        "unified_memory": UNIFIED_MEMORY,
        "torch_version": torch.__version__,
        "cuda_version":  torch.version.cuda if not is_rocm else None,
        "rocm_version":  getattr(torch.version, "hip", None),
    })


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest) -> GenerateResponse:
    if not model_ready:
        raise HTTPException(status_code=503, detail=model_error or "Model is still loading")

    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)
    width, height = snap_to_supported(req.width, req.height)

    # Generator device: CPU when offloading (generator lives on host), GPU otherwise.
    gen_device = "cpu" if (CPU_OFFLOAD and not UNIFIED_MEMORY) or BACKEND == "cpu" else DEVICE
    generator = torch.Generator(device=gen_device).manual_seed(seed)

    t0 = time.time()
    result = pipe(
        prompt=req.prompt,
        negative_prompt=req.negative_prompt or None,
        width=width,
        height=height,
        num_inference_steps=req.num_inference_steps,
        guidance_scale=req.guidance_scale,
        generator=generator,
        output_type="pil",
    )
    elapsed_ms = int((time.time() - t0) * 1000)
    image = result.images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    image_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

    log.info(
        "Generated %dx%d in %d ms  seed=%d  steps=%d  backend=%s",
        width, height, elapsed_ms, seed, req.num_inference_steps, BACKEND,
    )

    return GenerateResponse(
        image=image_b64,
        width=width,
        height=height,
        seed=seed,
        model=MODEL_ID,
        backend=BACKEND,
        device=DEVICE,
        elapsed_ms=elapsed_ms,
    )
