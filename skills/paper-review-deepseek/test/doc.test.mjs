/**
 * Checks SKILL.md against the code it documents.
 *
 * Two ways this drifts silently: a lens gets added but never appears in the
 * menu table, or a lens is renamed and the table keeps the old id. Both leave
 * the reader with a command that does not run, so check it instead of trusting
 * it. No network, no token.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LENSES, FOLLOWUPS, PROMPT_MAX } from '../src/lenses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, '..');
const doc = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// Every id must be documented, as a `code span` in the doc.
for (const lens of LENSES) {
  check(doc.includes('`' + lens.id + '`'), `lens \`${lens.id}\` is not documented in SKILL.md`);
}
for (const f of FOLLOWUPS) {
  check(doc.includes('`' + f.id + '`'), `follow-up \`${f.id}\` is not documented in SKILL.md`);
}

// The documented counts must match reality.
check(
  doc.includes(`${LENSES.length} 条镜头`),
  `SKILL.md does not say "${LENSES.length} 条镜头" (it says something else, or the count moved)`
);
check(
  doc.includes(`${FOLLOWUPS.length} 条追问`),
  `SKILL.md does not say "${FOLLOWUPS.length} 条追问"`
);

// The cap is the whole point of the design; the doc must state the real value.
check(
  doc.includes(PROMPT_MAX + ' 字') || doc.includes(PROMPT_MAX + '字'),
  `SKILL.md does not mention the real ${PROMPT_MAX}-character cap`
);

// Length invariant, asserted here too so `npm test` catches a too-long prompt
// even though lenses.mjs already throws at import time.
for (const item of [...LENSES, ...FOLLOWUPS]) {
  const n = Array.from(item.ask).length;
  check(n <= PROMPT_MAX, `${item.id} is ${n} characters, over the ${PROMPT_MAX} cap`);
}

// No free-form question path anywhere in the CLI.
const cli = readFileSync(join(skillDir, 'tools/ask-paper.mjs'), 'utf8');
check(!/['"]question['"]\s*:/.test(cli), 'ask-paper.mjs appears to expose a --question option');
check(cli.includes('PROMPT_MAX'), 'ask-paper.mjs does not reference PROMPT_MAX');

if (failures.length) {
  for (const f of failures) console.error('FAIL ' + f);
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}

console.log(
  `ok — ${LENSES.length} lenses + ${FOLLOWUPS.length} follow-ups documented, ` +
    `all prompts <= ${PROMPT_MAX} chars, no free-form path`
);
