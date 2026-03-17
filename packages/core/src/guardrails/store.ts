/**
 * Runtime-mutable guardrail store.
 * Initialized from the loaded config; admin can update at runtime via REST API.
 * sandboxShellExec is always forced to true — cannot be disabled at runtime.
 */

import { getConfig } from "../config/loader.js";

export interface GuardrailState {
  promptInjectionBlock: boolean;
  outputSecretScan: boolean;
  maxInputLength: number;
  sandboxShellExec: true; // always true — cannot be changed
}

let _state: GuardrailState | null = null;

function init(): GuardrailState {
  const cfg = getConfig().guardrails;
  return {
    promptInjectionBlock: cfg.promptInjectionBlock,
    outputSecretScan: cfg.outputSecretScan,
    maxInputLength: cfg.maxInputLength,
    sandboxShellExec: true,
  };
}

export function getGuardrails(): GuardrailState {
  if (!_state) _state = init();
  return _state;
}

export function updateGuardrails(patch: Partial<Omit<GuardrailState, "sandboxShellExec">>): GuardrailState {
  if (!_state) _state = init();
  if (patch.promptInjectionBlock !== undefined) _state.promptInjectionBlock = patch.promptInjectionBlock;
  if (patch.outputSecretScan !== undefined) _state.outputSecretScan = patch.outputSecretScan;
  if (patch.maxInputLength !== undefined) {
    const v = Math.max(100, Math.min(100000, patch.maxInputLength));
    _state.maxInputLength = v;
  }
  // sandboxShellExec always stays true
  _state.sandboxShellExec = true;
  return _state;
}

export function resetGuardrails(): GuardrailState {
  _state = init();
  return _state;
}

export function resetGuardrailsForTests(): void {
  _state = null;
}
