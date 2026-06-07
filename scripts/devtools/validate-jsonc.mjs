import { readdirSync, readFileSync } from 'fs';

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

// Sub-agents live in role-based files under workspace/agents/ — glob them all rather than
// hardcoding a single monolith, so the validator stays correct as the layout evolves.
function shardFiles(subdir) {
  return readdirSync(`F:/StarlingAI/workspace/${subdir}`)
    .filter((f) => f.endsWith('.jsonc'))
    .map((f) => `workspace/${subdir}/${f}`)
    .sort();
}

const sceneFiles = shardFiles('scenes');
const jobFiles = shardFiles('jobs');
const files = [...sceneFiles, ...jobFiles, ...shardFiles('agents')];

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
  // Scenes and jobs are sharded across category files — merge them for the reference check.
  const scenes = {};
  for (const f of sceneFiles) Object.assign(scenes, parsed.get(f)?.scenes ?? {});
  const jobs = {};
  for (const f of jobFiles) Object.assign(jobs, parsed.get(f)?.jobs ?? {});
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
