import { readFileSync } from 'fs';

function stripJsonc(s) {
  let out = '', i = 0, inStr = false, escape = false;
  while (i < s.length) {
    const c = s[i];
    if (escape) { out += c; escape = false; i++; continue; }
    if (inStr) {
      if (c === '\\') { out += c; escape = true; i++; continue; }
      if (c === '"') inStr = false;
      out += c; i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i - 1] === '*' && s[i] === '/')) i++; i++; continue; }
    out += c; i++;
  }
  return out;
}

const files = [
  'workspace/scenes/10-scenes.jsonc',
  'workspace/jobs/10-jobs.jsonc',
  'workspace/agents/20-subagents-general.jsonc',
];

let ok = true;
const parsed = new Map();
for (const f of files) {
  const raw = readFileSync(`F:/StarlingAI/${f}`, 'utf8');
  try {
    parsed.set(f, JSON.parse(stripJsonc(raw)));
    console.log('OK:', f);
  } catch (e) {
    console.log('ERR:', f, e.message);
    ok = false;
  }
}

if (ok) {
  const scenes = parsed.get('workspace/scenes/10-scenes.jsonc')?.scenes ?? {};
  const jobs = parsed.get('workspace/jobs/10-jobs.jsonc')?.jobs ?? {};
  const sceneNames = new Set(Object.keys(scenes));
  const missingSceneRefs = [];

  for (const [jobName, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    for (const [index, step] of steps.entries()) {
      if (!step?.scene) continue;
      if (!sceneNames.has(step.scene)) {
        missingSceneRefs.push(`${jobName}[${index}] -> ${step.scene}`);
      }
    }
  }

  if (missingSceneRefs.length > 0) {
    console.log('ERR: unresolved job scene references');
    for (const ref of missingSceneRefs) {
      console.log('  -', ref);
    }
    ok = false;
  } else {
    console.log('OK: all job scene references resolve');
  }
}

process.exit(ok ? 0 : 1);
