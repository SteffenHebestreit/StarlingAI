"""Download the model files the comfyui profile expects into the models volume.

Files already in place are skipped, so it runs at every start. Each file lands under a
temporary name and is renamed only when complete, so ComfyUI never lists half a model.

COMFYUI_MODEL_SETS picks the sets from models.json by name, comma separated; empty means
every set, "none" means nothing. A gated file needs HF_TOKEN from an account that has
accepted the model's license; without it that file is skipped with a note, not an error.
"""

import json
import os
import pathlib
import shutil
import sys
import urllib.request

MODELS_DIR = pathlib.Path(os.environ.get("COMFYUI_MODELS_DIR", "/opt/comfyui/models"))
MANIFEST = pathlib.Path(__file__).with_name("models.json")
STAGING = MODELS_DIR / ".downloads"


def log(message: str) -> None:
    print(f"[comfyui-models] {message}", flush=True)


def selected_sets(manifest: dict) -> list:
    raw = os.environ.get("COMFYUI_MODEL_SETS", "").strip()
    sets = manifest["sets"]
    if not raw:
        return sets
    if raw == "none":
        return []
    wanted = [name.strip() for name in raw.split(",") if name.strip()]
    known = {s["name"] for s in sets}
    for name in wanted:
        if name not in known:
            log(f"unknown model set {name!r}; known: {', '.join(sorted(known))}")
    return [s for s in sets if s["name"] in wanted]


def fetch_from_hub(entry: dict, target: pathlib.Path, token: str | None) -> None:
    from huggingface_hub import hf_hub_download

    downloaded = hf_hub_download(
        repo_id=entry["repo"],
        filename=entry["path"],
        revision=entry.get("revision"),
        token=token,
        local_dir=STAGING,
    )
    shutil.move(downloaded, target)


def fetch_from_url(entry: dict, target: pathlib.Path) -> None:
    partial = STAGING / (target.name + ".part")
    with urllib.request.urlopen(entry["url"], timeout=60) as response, open(partial, "wb") as out:
        shutil.copyfileobj(response, out, 1 << 20)
    expected = entry.get("bytes")
    if expected is not None and partial.stat().st_size != expected:
        size = partial.stat().st_size
        partial.unlink()
        raise RuntimeError(f"got {size} bytes, expected {expected}")
    partial.rename(target)


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    token = os.environ.get("HF_TOKEN") or None
    STAGING.mkdir(parents=True, exist_ok=True)
    failed = 0
    for model_set in selected_sets(manifest):
        for entry in model_set["files"]:
            target = MODELS_DIR / entry["folder"] / entry["name"]
            if target.exists():
                continue
            if entry.get("gated") and not token:
                log(
                    f"skipped {entry['name']} ({model_set['name']}): {entry['repo']} is gated. "
                    "Accept its license on huggingface.co and set HF_TOKEN."
                )
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            log(f"downloading {entry['folder']}/{entry['name']} ({model_set['name']})")
            try:
                if "url" in entry:
                    fetch_from_url(entry, target)
                else:
                    fetch_from_hub(entry, target, token)
                log(f"ready: {entry['folder']}/{entry['name']}")
            except Exception as error:  # one failed file must not stop the others
                failed += 1
                reason = str(error).splitlines()[0] if str(error) else type(error).__name__
                log(f"failed {entry['name']}: {reason}")
    shutil.rmtree(STAGING / ".cache", ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
