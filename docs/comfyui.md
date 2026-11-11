# ComfyUI workflows

The swarm can build, change, run and export [ComfyUI](https://github.com/Comfy-Org/ComfyUI) node workflows. ComfyUI runs as its own container on an NVIDIA GPU. Three tools drive it, and a person can open the same workflows in ComfyUI's editor and keep working there.

This sits beside `generate_image`, which renders one picture on the configured image backend. Use ComfyUI for what one render cannot do: upscaling, LoRAs, edits with several reference images, chains of steps, and any workflow you want to keep and edit.

## Turning it on

```bash
node scripts/sai.mjs start --comfyui      # or SAI_ENABLE_COMFYUI=1 in .env
```

`--all` includes ComfyUI only on a machine with an NVIDIA GPU (detected with `nvidia-smi`, or forced with `SAI_GPU=1`). Without a GPU it starts on the CPU, which works but is far too slow for real use.

Starting it also hands the gateway its address. `SAI_COMFYUI_URL` (default `http://comfyui:8188`) fills `multimodal.comfyui.baseUrl`, and `SAI_COMFYUI_EDITOR_URL` (default `http://localhost:8188`) fills `multimodal.comfyui.editorUrl`. When `baseUrl` is empty the tools say ComfyUI is not set up, and nothing else changes. To use a ComfyUI that runs elsewhere, set `multimodal.comfyui.baseUrl` in config instead.

| Setting | Default | Meaning |
|---|---|---|
| `multimodal.comfyui.baseUrl` | `""` | Where the gateway reaches ComfyUI's API. Empty turns the tools off. |
| `multimodal.comfyui.editorUrl` | `""` | The address a person's browser opens the editor at. It is given to the user with an exported workflow. |
| `multimodal.comfyui.runTimeoutMs` | `900000` | How long one run may take, from submission to its last file, queue included. |

## The container (`docker/comfyui`)

- ComfyUI is pinned to a release tag (`COMFYUI_REF`, currently `v0.44.0`) and uses PyTorch cu130.
- One custom node is baked in: [workflow-to-api-converter-endpoint](https://github.com/SethRobinson/comfyui-workflow-to-api-converter-endpoint), pinned to a reviewed commit. It turns a workflow saved in the editor into the API format that `/prompt` runs. ComfyUI has no server-side converter of its own. The node is a pure data transform with no file, network or process access.
- ComfyUI-Manager is not installed, so nothing installs nodes or pulls code at run time.
- The server runs with `--offline`. Paid partner (API) nodes are off, and the editor fetches nothing from the internet.
- The editor is published on the host's loopback only (`127.0.0.1:${SAI_COMFYUI_PORT:-8188}`), because ComfyUI has no login of its own. The gateway reaches it over the internal network.
- Two volumes hold its data: `gc-comfyui-models` for the model files and `gc-comfyui-data` for outputs, inputs and the editor's saved workflows.

### Models

`docker/comfyui/fetch_models.py` downloads the files listed in `docker/comfyui/models.json` at each start. Files already in place are skipped. Each file lands under a temporary name and is renamed only when complete, so ComfyUI never lists half a model. The downloads run in the background, so the server answers at once.

| Set | Files | Size | Licence |
|---|---|---|---|
| `qwen-image-2.1` | Qwen-Image 2.1 int8 DiT, Qwen3-VL-8B int8 text encoder, VAE (Comfy-Org) | ~17 GB | Qwen licence |
| `flux-3-klein` | FLUX 3 Image Klein int8 distilled DiT + Qwen3-VL-4B int8 (black-forest-labs), FLUX.2 VAE | ~11 GB | FLUX Kommunity License, **gated** |
| `upscale` | Real-ESRGAN x4plus | 67 MB | BSD-3-Clause |

The file names match ComfyUI's official templates, so those templates run unchanged.

- `COMFYUI_MODEL_SETS` picks sets by name, comma separated. Empty means all, `none` means nothing.
- `COMFYUI_FETCH_MODELS=0` turns the download off.
- The gated FLUX files need `HF_TOKEN` from a Hugging Face account that has accepted the model's licence. Without a token they are skipped with a note and the other sets still load.

## The tools

| Tool | Tier | What it does |
|---|---|---|
| `comfyui_catalog` | 0 | Looks up node types (a search, whose best hits show their inputs and outputs, or one type in full), model files (a folder or a word from a file name), the official templates this server can run, and the editor's saved workflows. |
| `comfyui_workflow` | 1 | Creates or changes a workflow kept as an API-format JSON file in the workspace. It starts from a template, an editor workflow or a PNG ComfyUI made, applies `insert` / `add` / `set` / `remove` / `title` operations, and checks the result against the server's nodes and model files. It can also save the workflow to the editor's library (`save_to_editor`) or write an editor-format file (`editor_file`). |
| `comfyui_run` | 1 | Runs a workflow file, `editor:<name>` or `template:<name>`. `set` overrides inputs for this run only, and `images` uploads workspace pictures to LoadImage inputs; a picture an earlier run saved is found by its file name alone. The outputs are saved under `generated/comfyui/`. |

`image_creator` holds all three, and they are grantable to ephemeral agents. `researcher` also holds `comfyui_catalog`. A question about what the server has installed is usually flagged as needing outside facts, and a step on such a turn that names an agent working only from the text it is handed is redirected to `researcher`. The installed models are on the ComfyUI server, so the researcher reads them from there. Because they reach a configured service, an agent holding them runs in-process. `comfyui_run` is never answered from a turn's replay cache, since the workflow file it names can change between two identical calls.

### What happens to a workflow on the way

- **Templates and editor workflows** are converted to the API format by the converter node. The converter leaves out the values typed on a subgraph's own node: the official templates show prompt, seed, steps and model files there. Those values are written into the flattened inner nodes afterwards (`applySubgraphWidgetValues`). There is one value per widget input of the subgraph, and socket inputs have none.
- **Before a run**, a switch set to a fixed value is replaced by the branch it picks, and nodes no output needs are left out (`runnableGraph`). ComfyUI checks every reachable node, a switched-off branch included. The Qwen-Image 2.1 template keeps a 9 GB prompt enhancer behind a switch that is off, and without this step the whole run was refused for that missing file. An editor-drawn required input with no saved value, such as ImageCompare's view, gets an empty value.
- **ComfyUI's check is the final word.** A refused part is reported per node and input, together with the closest valid choice (for example the right model file name). When ComfyUI refuses some outputs but runs others (HTTP 200 with `node_errors`), the run fails only if nothing was saved. Otherwise the result carries a note.
- **Export to the editor** writes the workflow as it runs, with switches resolved and unused branches left out. The editor resolves no switch, so the full template opened with its switched-off enhancer flagged for a missing model, and Run would have been refused. The export is laid out left to right, with seeds set to `fixed` so that pressing Run reproduces the result. The copy is then read back through the converter and compared with the workflow, and any difference is reported. Checked in a real browser: for the exported Qwen template, what the editor would send on Run is identical to the workflow.
- **Every saved PNG carries its workflow as it ran.** Dragged onto the ComfyUI page, it opens the workflow behind it. The tool's answer gives each PNG's pixel size, which is how an added stage shows that it ran.
- **While a run is in progress** a poll ComfyUI does not answer within 15 s is repeated. A heavy job can starve its HTTP side for minutes, and the job goes on: only the run's own time limit (`runTimeoutMs`) ends the wait.

Node ids change on the way through the editor: flattened subgraph ids such as `459:458` become plain numbers. Operations, links and `set` keys therefore also take a node type or title that only one node has (`"KSampler.steps"`, `["VAEDecode", 0]`), or part of one (`"SaveImage"` for `SaveImageAdvanced`). Each `comfyui_workflow` answer starts with where the prompt, seed, settings, model files and picture inputs of the running nodes are. If an operation names no node, nothing is applied, but a workflow loaded with `start_from` is still saved, so the next call can change it without loading it again.

### Adding a stage to a workflow

A value written as part of exactly one of an input's choices is taken as that choice (`3:2` for `3:2 (Photo)`), and a link to a node that is not there, on an input only one node of the workflow can feed, is taken as the link to that node. Both are named in the answer.

`insert` puts a new node on a connection that exists. `before` names the node that should receive its output (`"KSampler"`, or `"<node>.<input>"` when several inputs fit). Left out, the stage goes in front of the workflow's output, if only one output fits. The old connection then feeds the new node, matched by type, and `inputs` supplies only what else it needs. An upscaler, a LoRA or a filter goes in this way without looking up ids.

`remove` takes a stage out of its chain the way ComfyUI's bypass does: what the stage was given goes on to the inputs it fed, where exactly one of its inputs carries that type. A loader, a decoder or a node blending two pictures leaves its inputs unconnected instead, and the answer names them. An `insert` without `before` in the same call takes the removed stage's place and feeds everything it fed: removing the official upscale template's `ImageScaleBy` and inserting `ImageUpscaleWithModel` keeps both the saved picture and the comparison on the new stage.

A node added by an operation that nothing reads from is reported as not connected, by `comfyui_workflow` and again by `comfyui_run`, because ComfyUI never runs it. Unused nodes a template brought along are not reported: 22 of the 265 official templates have some.

`prompt`, on `comfyui_workflow` and on `comfyui_run`, writes what the picture should show to the place the workflow keeps its prompt, so a template can be run without knowing its node ids: `comfyui_run` with `workflow: "template:image_qwen_image_2_1_t2i"` and `prompt: "a red fox in snow"`. Where a workflow has several prompt texts, the answer lists them and `set` writes the ones meant.

A template renders its authors' example until its prompt is changed. The prompt texts a template arrives with are marked, and while none of the workflow's prompts says anything else, `comfyui_workflow` reports the prompt as unchanged and `comfyui_run` opens its answer with a note naming that text. A prompt here is a text that becomes positive conditioning: of the 265 official templates 189 arrive with one, while the math expressions, patterns and shader code many keep in the same kind of text box are left alone. A `set` that names an input the node type does not have is refused with the node's inputs: ComfyUI would ignore it, and the change would silently go nowhere.

A template whose models are not installed is refused as a starting point, and the answer names templates that run here. `allow_unready: true` starts from it anyway, for a workflow meant to be kept or used once the models are there.

### Measured on an RTX 4080 (16 GB), ComfyUI 0.44.0

- Official Qwen-Image 2.1 text-to-image template, 1 MP, 25 steps: 25 s cold (model load included), 12–14 s warm.
- Official Qwen-Image 2.1 image-edit template with two uploaded references: 26–35 s.
- The text-to-image template with a Real-ESRGAN x4 stage inserted, 4096×4096 output: 20 s warm.
- The same at 4992×3328 while the reranker and the Laya sidecar also hold the GPU (15.8 of 16.4 GB in use): 371 s, with no answer to a status poll for over two minutes of it.
- "Welche Modelle hat ComfyUI gerade installiert?" through the whole swarm, with the local Qwen model as orchestrator: 4 of 5 answered with the server's own file list in 26–40 s. Before `image_creator`'s description opened with ComfyUI and `researcher` held `comfyui_catalog`, it was 0 of 10: the question went to agents that searched a filesystem. The miss left the agent open, and routing picked `computer_use_agent`.
- Export round trip (template → editor format → converter → compare), over 127 sampled official templates: 104 come back identical, including every Qwen-Image 2.1 and FLUX 3 Klein template. Most of the rest are video templates. The tool's comparison skips the hidden `codec` input of SaveVideo, and for the remainder its read-back check reports the difference.

## Multi-user

The ComfyUI server, its GPU queue, its output folder and its editor library are shared by every account. Results are copied into each caller's own workspace. Exports go to `starlingai/<account segment>/` in the editor library, and uploaded inputs to the same subfolder of ComfyUI's input folder. The editor itself has no accounts: anyone who can open its page sees every saved workflow.
