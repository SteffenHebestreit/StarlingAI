# Strix Halo / Ryzen AI Max — GPU Setup Guide

This document covers GPU compute for AMD Ryzen AI Max / Strix Halo (gfx1151) systems
running StarlingAI under WSL2 on Windows 11.

## Current Status (March 2026)

| Layer | Status |
|---|---|
| LLM inference (LM Studio on Windows, Vulkan) | ✅ Working — up to 96 GB via AMD VGM |
| ASR / TTS (container, CPU) | ✅ Working |
| Image generation (container, CPU) | ❌ Disabled — 57.7 GB model OOMs on WSL2 CPU |
| Image generation (container, ROCm / AMD GPU) | ⏳ Blocked — see below |

## Why Image Generation Doesn't Work Yet

Two independent blockers prevent ROCm from working inside WSL2 Docker containers on gfx1151:

**1. /dev/kfd is not exposed in WSL2**
AMD's KFD (Kernel Fusion Driver) is never exposed by the Windows hypervisor in WSL2.
The correct WSL2 device is `/dev/dxg` (WDDM proxy), but:

**2. gfx1151 has a librocdxg detection bug**
`librocdxg` (the ROCm library that uses `/dev/dxg`) fails to detect gfx1151 hardware.
Tracked at [ROCm issue #5900](https://github.com/ROCm/ROCm/issues/5900) and
[#6022](https://github.com/ROCm/ROCm/issues/6022). No fix as of March 2026.

**3. Flux on WSL2 CPU is still constrained by download size and CPU throughput**
The stack now defaults to `black-forest-labs/FLUX.1-schnell`, which is far more
manageable than the old Qwen image checkpoint for practical use, but it is still
substantially heavier than SD 1.5 and much slower on WSL2 CPU than on native GPU-backed Linux.

## How LLM Inference Works (No Issues)

LM Studio runs natively on Windows (not in Docker) using Vulkan via AMD Variable Graphics
Memory (VGM). It can dynamically allocate up to 96 GB of the shared LPDDR5X pool for
model weights. The gateway reaches it at `host.docker.internal:1234`.

## Starting the Stack

```bash
# Start all services except image generation (recommended for now)
./start.sh up -d

# Rebuild images
./start.sh up -d --build

# Also start image generation (now defaults to CPU-safe Stable Diffusion)
./start.sh image up -d
```

`start.sh` always merges both compose files so ROCm build-args and env vars are applied.

## Recommended .wslconfig

```ini
# C:\Users\<you>\.wslconfig
[wsl2]
memory=88GB    # leave ~8 GB for Windows; maximises RAM for containers
processors=16  # match your core count
swap=0         # prevent paging GPU allocations to disk
```

## When ROCm WSL2 Support Lands for gfx1151

Once AMD fixes the `librocdxg` gfx1151 detection bug:

1. Uncomment the `/dev/dxg` device lines in `docker-compose.strix-halo.yml`:
   ```yaml
   devices:
     - /dev/dxg:/dev/dxg
     - /dev/dri:/dev/dri
   volumes:
     - /usr/lib/wsl:/usr/lib/wsl:ro
   environment:
     LD_LIBRARY_PATH: /usr/lib/wsl/lib
   ```

2. Rebuild the ROCm images:
   ```bash
   ./start.sh image up -d --build
   ```

3. Verify the service reports `backend: rocm` and `unified_memory: true`:
   ```bash
   curl -sf http://127.0.0.1:5005/health | jq .
   ```

## When Running on Native Linux (Not WSL2)

Native Linux exposes `/dev/kfd` directly. Requirements:
- Kernel ≥ 6.14
- ROCm 7.2: `sudo amdgpu-install --usecase=rocm --no-dkms`
- `HSA_OVERRIDE_GFX_VERSION=11.5.1` (already set in `docker-compose.strix-halo.yml`)

Uncomment the native Linux device block in `docker-compose.strix-halo.yml`:
```yaml
devices:
  - /dev/kfd:/dev/kfd
  - /dev/dri:/dev/dri
group_add: [video, render]
security_opt: [seccomp=unconfined]
```

## GFX Version Reference

| GPU | GFX ID | HSA_OVERRIDE_GFX_VERSION |
|---|---|---|
| Strix Halo (Ryzen AI Max / Max+, Radeon 8060S) | gfx1151 | 11.5.1 |
| Strix Point (Ryzen AI 300 series) | gfx1150 | 11.5.0 |
| RX 7000 series (RDNA 3 dGPU) | gfx1100 | 11.0.0 |

## Image Generation Model Notes

- **Current model**: `black-forest-labs/FLUX.1-schnell` — the official fast Flux checkpoint with defaults tuned for low step count and zero guidance
- **Auth requirement**: set `HF_TOKEN` in `.env` so the container can download the gated model files from Hugging Face
- The image service still supports overrides through `IMAGE_MODEL` if you want to try a different open diffusers checkpoint later
- GPU-backed native Linux or future ROCm-on-WSL support will still improve latency substantially compared with CPU mode
