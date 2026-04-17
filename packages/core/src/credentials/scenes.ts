/**
 * Runtime scene management.
 *
 * Two sources merged at read time (config file takes precedence):
 *   1. `config.scenes` — declared in starlingai.json (read-only via API)
 *   2. Encrypted credential store — managed via REST API at runtime
 *
 * Store key schema:
 *   scene:<name>:description
 *   scene:<name>:task
 *   scene:<name>:webhookKey   (optional)
 */
import { getCredential, setCredential, deleteCredential, listCredentialNames } from "./store.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("credentials:scenes");

const SCENE_DESCRIPTION_KEY = (name: string) => `scene:${name}:description`;
const SCENE_TASK_KEY         = (name: string) => `scene:${name}:task`;
const SCENE_WEBHOOK_KEY      = (name: string) => `scene:${name}:webhookKey`;

export interface SceneSummary {
  name: string;
  description: string;
  task: string;
  webhookKey?: string;
  source: "config" | "store";
  /** Named template variables declared in scene config (config-file scenes only) */
  params?: Record<string, { description?: string; default?: string }>;
  /** Sub-agents this scene may delegate to (undefined = no restriction) */
  allowedAgents?: string[];
  /** Tool names that must pause for human approval when called from this scene */
  humanInLoopSteps?: string[];
  /** Name of an approvalChannels entry — used when this scene is triggered via webhook */
  approvalChannel?: string;
  /** Per-scene override for the approval channel timeout (ms). Falls back to channel config when absent. */
  approvalTimeoutMs?: number;
}

export function listAllScenes(): SceneSummary[] {
  const results: SceneSummary[] = [];
  const seen = new Set<string>();

  // From config file (higher precedence, read-only)
  const config = getConfig();
  for (const [name, scene] of Object.entries(config.scenes ?? {})) {
    seen.add(name);
    results.push({
      name,
      description: scene.description,
      task: scene.task,
      webhookKey: scene.webhookKey,
      source: "config",
      params: scene.params,
      allowedAgents: scene.allowedAgents,
      humanInLoopSteps: scene.humanInLoopSteps,
      approvalChannel: scene.approvalChannel,
      approvalTimeoutMs: scene.approvalTimeoutMs,
    });
  }

  // From encrypted store (API-managed)
  for (const key of listCredentialNames()) {
    if (!key.startsWith("scene:") || !key.endsWith(":description")) continue;
    const name = key.slice("scene:".length, -":description".length);
    if (seen.has(name)) continue;
    const description = getCredential(SCENE_DESCRIPTION_KEY(name)) ?? "";
    const task = getCredential(SCENE_TASK_KEY(name)) ?? "";
    if (!description || !task) continue;
    results.push({
      name,
      description,
      task,
      webhookKey: getCredential(SCENE_WEBHOOK_KEY(name)) ?? undefined,
      source: "store",
    });
  }

  return results;
}

export function getScene(name: string): SceneSummary | null {
  // Config takes precedence
  const config = getConfig();
  const configScene = config.scenes?.[name];
  if (configScene) {
    return {
      name,
      description: configScene.description,
      task: configScene.task,
      webhookKey: configScene.webhookKey,
      source: "config",
      params: configScene.params,
      allowedAgents: configScene.allowedAgents,
      humanInLoopSteps: configScene.humanInLoopSteps,
      approvalChannel: configScene.approvalChannel,
      approvalTimeoutMs: configScene.approvalTimeoutMs,
    };
  }
  const description = getCredential(SCENE_DESCRIPTION_KEY(name));
  const task = getCredential(SCENE_TASK_KEY(name));
  if (!description || !task) return null;
  return {
    name,
    description,
    task,
    webhookKey: getCredential(SCENE_WEBHOOK_KEY(name)) ?? undefined,
    source: "store",
  };
}

export interface SceneInput {
  description: string;
  task: string;
  webhookKey?: string;
}

export function saveScene(name: string, input: SceneInput): void {
  if (!name.match(/^[a-z0-9_-]+$/i)) {
    throw new Error("Scene name must only contain letters, numbers, underscores, and hyphens");
  }
  setCredential(SCENE_DESCRIPTION_KEY(name), input.description);
  setCredential(SCENE_TASK_KEY(name), input.task);
  if (input.webhookKey) {
    setCredential(SCENE_WEBHOOK_KEY(name), input.webhookKey);
  } else {
    deleteCredential(SCENE_WEBHOOK_KEY(name));
  }
  log.info({ name }, "Scene saved to store");
}

export function deleteScene(name: string): void {
  deleteCredential(SCENE_DESCRIPTION_KEY(name));
  deleteCredential(SCENE_TASK_KEY(name));
  deleteCredential(SCENE_WEBHOOK_KEY(name));
  log.info({ name }, "Scene deleted from store");
}
