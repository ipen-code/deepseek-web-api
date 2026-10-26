#!/usr/bin/env node
/**
 * One-shot: send a paper to DeepSeek as a real attachment, ask fixed questions,
 * save the raw answers.
 *
 *   node tools/ask-paper.mjs paper.tex                 # the scoring question
 *   node tools/ask-paper.mjs paper.tex --lens reject   # one divergence lens
 *   node tools/ask-paper.mjs paper.tex --lens all      # every lens, one file
 *   node tools/ask-paper.mjs paper.tex --thinking --out out/my.md
 *
 * Every question is HARDCODED and capped at 50 characters, and there is no way
 * to pass arbitrary text on the command line: the point is that a question is
 * always asked the same way, so runs stay comparable and no essay-sized prompt
 * slips in. `--lens` picks from the fixed menu in `src/lenses.mjs`; the default
 * is the scoring question. Both modules refuse to load if a prompt is too long.
 *
 * What this tool will NOT do: judge the answer. Judging needs the manuscript,
 * the experiment log, and the author's intent — none of which live here. It is
 * also read-only with respect to the manuscript and never writes next to it
 * unless `--out` points there.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { makeTransport } from '../src/transport.mjs';
import {
  LENSES,
  FOLLOWUPS,
  FOLLOWUP_IDS,
  PROMPT_MAX as LENS_MAX,
  PINS,
  resolveLensSpec,
  promptFor,
  followupById,
} from '../src/lenses.mjs';

/** The scoring question. Keep it under PROMPT_MAX characters. */
export const PROMPT = '这是我的论文，请评价一下，满分10分打多少分？';

/** Hard cap on prompt length. Not a default, a limit. */
export const PROMPT_MAX = 50;

if (LENS_MAX !== PROMPT_MAX) {
  throw new Error(`ask-paper: PROMPT_MAX (${PROMPT_MAX}) disagrees with lenses.mjs (${LENS_MAX}).`);
}

const promptLength = Array.from(PROMPT + PINS).length;
if (promptLength > PROMPT_MAX) {
  throw new Error(
    `ask-paper: PROMPT + PINS is ${promptLength} characters, over the ${PROMPT_MAX}-character cap. Shorten it.`
  );
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    lens: { type: 'string', short: 'l' },
    follow: { type: 'string', short: 'f' },
    thinking: { type: 'boolean', default: false },
    search: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '900000' },
    quiet: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const lensMenu = [
  'Questions (all hardcoded, all <= ' + PROMPT_MAX + ' chars — no free-form prompts):',
  `  (default)  score        ${PROMPT}`,
  ...LENSES.map((l) => `  ${l.id.padEnd(11)}${l.ask}`),
];

const followMenu = [
  '',
  'Follow-ups (second turn, same session — only make sense after a question):',
  ...FOLLOWUPS.map((f) => `  ${f.id.padEnd(11)}${f.ask}`),
];

if (values.help || !positionals.length) {
  console.log(
    [
      'Usage: node tools/ask-paper.mjs <paper.tex> [options]',
      '',
      'Uploads the file as a real attachment, asks fixed questions, prints the answers.',
      '',
      ...lensMenu,
      ...followMenu,
      '',
      'Options:',
      '  -o, --out <path>       Report path (default: ./.deepseek-feedback/<paper>.feedback.md)',
      '  -l, --lens <ids>       Lens id, comma list, or "all". Omit for the scoring question',
      '  -f, --follow <ids>     Follow-up id or comma list, run as a SECOND turn in the same',
      '                         session (they refer to "上面"). Options: ' + FOLLOWUP_IDS.join(', '),
      '      --thinking         Enable deep reasoning (slower, usually better on theory)',
      '      --search           Enable web search',
      '      --timeout <ms>     Per-question timeout (default 900000)',
      '      --quiet            Suppress progress on stderr',
      '      --json             Print only JSON to stdout',
      '',
      "Judging the answers is the caller's job — that is the point of the workflow.",
      'The manuscript is read-only input; this tool never modifies it.',
    ].join('\n')
  );
  process.exit(values.help ? 0 : 1);
}

/** @returns {{id:string,label:string,ask:string}[]} */
function questionsFor(v) {
  if (!v.lens) return [{ id: 'score', label: '评分', ask: PROMPT + PINS }];
  return resolveLensSpec(v.lens).map((l) => ({ id: l.id, label: l.label, ask: promptFor(l) }));
}

let questions;
try {
  questions = questionsFor(values);
} catch (e) {
  console.error(e?.message ?? e);
  process.exit(1);
}

const texPath = resolve(positionals[0]);
if (!existsSync(texPath)) {
  console.error(`No such file: ${texPath}`);
  process.exit(1);
}

const log = values.quiet ? () => {} : (m) => console.error(m);
const transport = await makeTransport({ log });

const bytes = readFileSync(texPath).length;
const t0 = Date.now();

let file;
try {
  log(`uploading ${basename(texPath)} (${bytes} bytes) ...`);
  file = await transport.uploadFile(texPath);
  log(`  -> ${file.id}  ${file.tokens} tokens  ${file.status}`);
} catch (e) {
  console.error(`upload failed: ${e?.message ?? e}`);
  process.exit(1);
}

let followups = [];
if (values.follow) {
  try {
    const ids = values.follow === 'all' ? FOLLOWUP_IDS : values.follow.split(',').map((s) => s.trim());
    followups = ids.map((id) => followupById(id));
  } catch (e) {
    console.error(e?.message ?? e);
    process.exit(1);
  }
}

/** @type {{id:string,label:string,ask:string,text:string,reasoning:string|null,tokens:number|null,seconds:number,turn?:number,parentId?:string|null}[]} */
const answers = [];

for (const [i, q] of questions.entries()) {
  const at = Date.now();
  log(`[${i + 1}/${questions.length}] ${q.id}: ${q.ask}`);

  let first;
  try {
    const r = await transport.complete({
      prompt: q.ask,
      thinking: values.thinking,
      search: values.search,
      refFileIds: [file.id],
      timeoutMs: Number(values.timeout),
    });
    first = r;
    const secs = (Date.now() - at) / 1000;
    answers.push({
      ...q,
      text: r.text ?? '',
      reasoning: r.reasoning ?? null,
      tokens: r.tokens ?? null,
      seconds: Number(secs.toFixed(1)),
      turn: 1,
    });
    log(`  <- ${r.tokens ?? '?'} tokens in ${secs.toFixed(1)}s`);
  } catch (e) {
    console.error(`  ! ${q.id} failed: ${e?.message ?? e}`);
    if (e?.code === 40002 || e?.code === 40003) {
      console.error('Token missing or expired — run `node tools/capture-token.mjs` in the repo root.');
      break;
    }
    answers.push({
      ...q,
      text: `(failed: ${e?.message ?? e})`,
      reasoning: null,
      tokens: null,
      seconds: 0,
      turn: 1,
    });
    continue;
  }

  // Second turn: same chat session, so "上面" still means the answer above.
  // Without the session there is nothing to refer back to, which is why this is
  // a separate code path rather than just another question in the list.
  for (const [j, f] of followups.entries()) {
    if (!first.sessionId) {
      console.error(`  ! follow-up ${f.id} skipped: no session id returned`);
      break;
    }
    const at2 = Date.now();
    log(`    [${j + 1}/${followups.length}] ${f.id}: ${f.ask}`);
    try {
      const r2 = await transport.complete({
        prompt: f.ask,
        chatSessionId: first.sessionId,
        parentMessageId: first.messageId,
        timeoutMs: Number(values.timeout),
      });
      const secs2 = (Date.now() - at2) / 1000;
      answers.push({
        id: `${q.id}/${f.id}`,
        label: `${q.label} → ${f.label}`,
        ask: f.ask,
        text: r2.text ?? '',
        reasoning: r2.reasoning ?? null,
        tokens: r2.tokens ?? null,
        seconds: Number(secs2.toFixed(1)),
        turn: 2,
        parentId: r2.messageId,
      });
      log(`      <- ${r2.tokens ?? '?'} tokens in ${secs2.toFixed(1)}s`);
      // Chain: the next follow-up refers to the answer just given.
      first = { ...first, messageId: r2.messageId, sessionId: r2.sessionId ?? first.sessionId };
    } catch (e) {
      console.error(`    ! ${f.id} failed: ${e?.message ?? e}`);
      answers.push({
        id: `${q.id}/${f.id}`,
        label: `${q.label} → ${f.label}`,
        ask: f.ask,
        text: `(failed: ${e?.message ?? e})`,
        reasoning: null,
        tokens: null,
        seconds: 0,
        turn: 2,
      });
    }
  }
}

if (!answers.length) {
  console.error('no answers produced');
  process.exit(1);
}

const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
const base = basename(texPath, extname(texPath));
const multi = questions.length > 1;
// Default output deliberately avoids the manuscript's own directory: the paper
// tree stays untouched unless the caller explicitly asks otherwise.
const outMd = values.out
  ? resolve(values.out)
  : join(
      process.cwd(),
      '.deepseek-feedback',
      multi ? `${base}.lenses.md` : `${base}.feedback.md`
    );
const outJson = outMd.replace(/\.md$/, '.json');

mkdirSync(dirname(outMd), { recursive: true });

const header = [
  `# DeepSeek feedback: ${basename(texPath)}`,
  '',
  `- attachment: \`${file.id}\` (${file.tokens} tokens, ${file.size ?? bytes} bytes)`,
  `- questions: ${answers.length} (all hardcoded, each <= ${PROMPT_MAX} chars, no free text accepted)`,
  `- follow-up turns: ${followups.length ? followups.map((f) => f.id).join(', ') + ' (second turn, same session)' : 'none'}`,
  `- deep thinking: ${values.thinking ? 'on' : 'off'}`,
  `- wall time: ${seconds}s`,
  '',
  '> Verbatim. Nothing here has been edited, and nothing here has been checked.',
  '',
];

const body = answers
  .map(
    (a, i) =>
      [
        '---',
        '',
        `## ${i + 1}. ${a.label} \`${a.id}\``,
        '',
        `- question: ${a.ask}`,
        `- turn: ${a.turn ?? 1}${(a.turn ?? 1) === 2 ? ' (same session as the answer above)' : ''}`,
        `- took: ${a.seconds}s` + (a.tokens != null ? `, ${a.tokens} output tokens` : ''),
        '',
        a.reasoning ? `<details><summary>reasoning</summary>\n\n${a.reasoning}\n\n</details>\n` : '',
        a.text || '(empty reply)',
        '',
      ]
        .filter((x) => x !== '')
        .join('\n')
  )
  .join('\n');

writeFileSync(outMd, header.join('\n') + '\n' + body + '\n', 'utf8');
writeFileSync(
  outJson,
  JSON.stringify(
    {
      paper: texPath,
      file,
      thinking: values.thinking,
      seconds,
      at: new Date().toISOString(),
      answers: answers.map((a) => ({
        id: a.id,
        label: a.label,
        question: a.ask,
        turn: a.turn ?? 1,
        reply: a.text,
        reasoning: a.reasoning,
        tokens: a.tokens,
        seconds: a.seconds,
      })),
    },
    null,
    2
  ),
  'utf8'
);

if (values.json) {
  console.log(JSON.stringify({ md: outMd, json: outJson, answers, file }, null, 2));
} else {
  for (const a of answers) {
    if (a.reasoning) console.log(`\n[reasoning · ${a.id}]\n${a.reasoning}\n`);
    console.log(`\n[${a.label} · ${a.id}]  ${a.ask}\n${a.text}\n`);
  }
  console.log(`\nwrote ${outMd}`);
  console.log(`      ${outJson}`);
}
