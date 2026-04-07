import fs from 'fs';
import path from 'path';

function walk(dir) {
  for (const file of fs.readdirSync(dir)) {
    const p = path.join(dir, file);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') walk(p);
    } else if (file.endsWith('.ts') || file.endsWith('.jsonc') || file.endsWith('.json') || file.endsWith('.md')) {
      const content = fs.readFileSync(p, 'utf8');
      if (content.includes('Mixed-domain')) {
        console.log("Found in: " + p);
      }
    }
  }
}
walk('.');
