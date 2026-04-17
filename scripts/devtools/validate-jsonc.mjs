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
for (const f of files) {
  const raw = readFileSync(`F:/StarlingAI/${f}`, 'utf8');
  try {
    JSON.parse(stripJsonc(raw));
    console.log('OK:', f);
  } catch (e) {
    console.log('ERR:', f, e.message);
    ok = false;
  }
}
process.exit(ok ? 0 : 1);
