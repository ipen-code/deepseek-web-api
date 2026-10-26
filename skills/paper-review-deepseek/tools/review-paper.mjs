#!/usr/bin/env node
/**
 * CLI entry: review a manuscript through the DeepSeek web session.
 *
 *   node tools/review-paper.mjs paper.tex
 *   node tools/review-paper.mjs paper.tex --out r.md --personas 3 --thinking
 *   node tools/review-paper.mjs paper.tex --only theory,adversary
 *
 * No API key, no browser window at run time — the token comes from
 * `tools/capture-token.mjs` in the parent repo.
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { runPaperReview, summarizeRun } from '../src/review.mjs';
import { makeTransport } from '../src/transport.mjs';
import { PERSONAS, personaById } from '../src/personas.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    personas: { type: 'string', short: 'p', default: '5' },
    thinking: { type: 'boolean', default: false },
    concurrency: { type: 'string', short: 'c', default: '2' },
    only: { type: 'string' },
    timeout: { type: 'string', default: '600000' },
    quiet: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || !positionals.length) {
  console.log(
    [
      'Usage: node tools/review-paper.mjs <paper.tex> [options]',
      '',
      'Options:',
      '  -o, --out <path>        Where to write the report (default: alongside the paper)',
      '  -p, --personas <n>      How many reviewers, 1–6 (default 5)',
      '  -c, --concurrency <n>   Parallel reviewers (default 2; the backend caps near 2)',
      '      --only <ids>        Comma-separated reviewer ids, overrides --personas',
      '      --thinking          Enable 深度思考 for every reviewer (slower, deeper)',
      '      --timeout <ms>      Per-request timeout (default 600000)',
      '      --quiet             Only print the final summary',
      '      --json              Print a machine-readable result instead of prose',
      '',
      `Reviewer ids: ${PERSONAS.map((p) => p.id).join(', ')}`,
    ].join('\n')
  );
  process.exit(positionals.length ? 0 : 1);
}

const texPath = resolve(positionals[0]);
if (!existsSync(texPath)) {
  console.error(`No such file: ${texPath}`);
  process.exit(1);
}

const log = values.quiet ? () => {} : (m) => console.error(m);

let chosen;
if (values.only) {
  const ids = values.only.split(',').map((s) => s.trim()).filter(Boolean);
  const missing = ids.filter((id) => !personaById(id));
  if (missing.length) {
    console.error(`Unknown reviewer id(s): ${missing.join(', ')}\nAvailable: ${PERSONAS.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }
  chosen = ids.map(personaById);
}

const transport = await makeTransport({ log });

const t0 = Date.now();
try {
  const res = await runPaperReview({
    texPath,
    outPath: values.out ? resolve(values.out) : undefined,
    personas: Number(values.personas),
    concurrency: Number(values.concurrency),
    thinking: values.thinking,
    timeoutMs: Number(values.timeout),
    chosen,
    label: 'paper-review-deepseek',
    complete: transport.complete,
    uploadFile: transport.uploadFile,
    onProgress: (e) => {
      if (e.stage === 'uploaded') log(`uploaded ${e.file.id} (${e.file.tokens} tokens, ${e.file.size} bytes)`);
      else if (e.stage === 'start') log(`  → ${e.persona}`);
      else if (e.stage === 'done')
        log(
          `  ✓ ${e.persona} ${(e.ms / 1000).toFixed(1)}s` +
            (e.scores ? ` total ${Object.values(e.scores).join('/')}` : ' (no scores)')
        );
      else if (e.stage === 'synthesis') log('synthesising …');
      else if (e.stage === 'written') log(`report → ${e.report}`);
    },
  });

  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  log(`done in ${wall}s`);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          report: res.report,
          file: res.file,
          total: res.scorecard?.total ?? null,
          verdict: res.scorecard?.verdict ?? null,
          rows: res.scorecard?.rows ?? [],
          wallSeconds: Number(wall),
        },
        null,
        2
      )
    );
  } else {
    console.log('\n' + summarizeRun(res));
  }
} catch (e) {
  console.error(`\nreview failed: ${e?.message ?? e}`);
  if (e?.code === 40002 || e?.code === 40003) {
    console.error('The web session token is missing or expired. Run `node tools/capture-token.mjs` in the parent repo.');
  }
  process.exit(1);
}
