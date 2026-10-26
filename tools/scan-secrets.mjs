/**
 * Pre-publish credential scan.
 *
 * A leaked `userToken` in a public repo is equivalent to handing over the
 * account, so this runs before every push and exits non-zero on any hit.
 *
 * Usage: node tools/scan-secrets.mjs [root]   (default: cwd)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.argv[2] ?? '.';
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'proof',
  '.deepseek-feedback',
  '.deepseek-review',
]);
const SKIP_EXT = new Set(['.wasm', '.pdf', '.png', '.jpg', '.zip', '.ico']);
const SKIP_FILES = new Set(['package-lock.json']);

const patterns = [
  [/[0-9a-f]{64}/i, '64-hex (token-shaped)'],
  [/sk-[A-Za-z0-9]{20,}/, 'sk- key'],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/, 'bearer'],
  [/eyJ[A-Za-z0-9_-]{20,}/, 'jwt'],
  [/api[_-]?key\s*[:=]\s*["'][^"']{12,}/i, 'api key literal'],
];

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(p);
    } else if (!SKIP_EXT.has(extname(entry)) && !SKIP_FILES.has(entry)) {
      files.push(p);
    }
  }
})(ROOT);

let hits = 0;
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const [re, name] of patterns) {
    const m = text.match(re);
    if (m) {
      console.log(`HIT ${name} in ${f} -> ${m[0].slice(0, 48)}`);
      hits++;
    }
  }
}

if (hits) {
  console.error(`scanned ${files.length} files, ${hits} hit(s) — do not publish`);
  process.exit(1);
}
console.log(`scanned ${files.length} files, no secrets found`);
