/**
 * Round report: what the loop says across repeated asks, and what survived.
 *
 * The design rule this tool enforces: the SCORE is not a measurement, the
 * FINDINGS are. We measured the score moving 5.46 → 7.5 → 8.2 → 8.5 on one
 * unchanged manuscript. So this report never averages scores into a verdict;
 * it prints them as-is, side by side, precisely so the instability is visible,
 * and then spends its real effort on which complaints kept coming back.
 *
 * Usage:
 *   node tools/round-report.mjs <a.json> [b.json ...] [-o report.md]
 *   node tools/round-report.mjs <a.json> <b.json> --lang-pin
 *
 * Input is the JSON that ask-paper.mjs wrote. When several files contain the
 * same lens, they are treated as REPEATS of that lens: a finding mentioned in
 * >=2 runs is "stable", one mentioned once is "unverified". Neither word means
 * true or false — that judgement belongs to the manuscript's owner.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { anchorsOf } from '../src/lenses.mjs';
import { contentTokens, containment } from '../src/findings.mjs';

/**
 * Two findings are the same complaint if they cite the same place AND say
 * something similar about it.
 *
 * The locator rule is what made this work at all. Clustering review prose
 * directly failed every control: two runs of the same lens on the same paper
 * shared 5% of sentences. Asking the model to cite `§IV-B` or `Eq.(12)` fixes
 * that, because two reviews flagging the same defect tend to cite the same
 * place.
 *
 * The trap, measured the hard way: a short paper has only a few theorems, so
 * `Theorem 1` appears in 75% of all runs. Matching on the locator alone made
 * every pair look 18% identical — a flat ceiling that measures nothing. A
 * locator present in most runs identifies the PAPER, not a complaint. So
 * locators are filtered by document frequency first, and sharing one is never
 * sufficient alone: it must coincide with actual prose overlap.
 *
 * Thresholds are calibrated, not guessed. Measured containment across every
 * (round 1 block, round 2 block) pair of four real lens runs:
 *
 *   same complaint, shared locator   0.33 – 0.49
 *   same complaint, no shared locator 0.74 – 0.84   (headline objection)
 *   different complaints            0.00 – 0.29
 *
 * Paragraphs paraphrase heavily, so a genuine match scores far below the 0.70
 * that worked for single sentences. Measured on four lenses x two runs of the
 * same manuscript, pairs that are the same complaint score 0.20-0.49 when they
 * cite a shared locator and 0.74-0.84 when they do not; genuinely different
 * complaints stay at 0.00-0.29. 0.20 / 0.60 sit inside those gaps.
 *
 * The first attempt used 0.30, which looked justified on the same data — and it
 * silently returned zero cross-lens findings, including the three matches that
 * are obviously the same complaint once you read them. A threshold that reports
 * nothing is not conservative, it is broken.
 */
const PARA_SHARED = 0.20;
const PARA_ALONE = 0.60;

function makeSamePoint() {
  return (a, b, paperLevel) => {
    const shared = a.anchors.filter((x) => b.anchors.includes(x) && !paperLevel.has(x));
    const c = containment(a.tokens, b.tokens);
    // A shared distinctive locator lowers the prose bar, but never to zero:
    // "Theorem 3" cited by two reviews can still be two different complaints.
    return shared.length ? c >= PARA_SHARED : c >= PARA_ALONE;
  };
}

/**
 * Locators that show up in most blocks describe the paper itself.
 *
 * The share is measured over CLAIMS, not over runs. Measured over runs, a
 * short paper gets wrecked: this manuscript has three theorems, so any review
 * that discusses Theorem 2 does so in three of four lenses, and every locator
 * gets filed as "paper-level" and thrown away. That is exactly what happened —
 * the filter ate `theorem2` and the cross-lens column came back empty while
 * three obvious matches sat right there in the output.
 *
 * Counting claims fixes the denominator: 74 claims, of which 6 cite Theorem 2,
 * is 8% — a locator that discriminates, not boilerplate. Only something cited
 * by more than 60% of all blocks deserves to be called paper-level.
 */
function paperLevelLocators(claims, _runCount) {
  const total = Math.max(1, claims.length);
  const seen = new Map();
  for (const c of claims) {
    for (const a of new Set(c.anchors)) seen.set(a, (seen.get(a) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n / total >= 0.6).map(([a]) => a));
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    'min-runs': { type: 'string', default: '2' },
    'min-lenses': { type: 'string', default: '2' },
    json: { type: 'boolean', default: false },
  },
});

const files = positionals.filter((f) => existsSync(f));
if (!files.length) {
  console.error('usage: node tools/round-report.mjs <feedback.json ...> [-o report.md]');
  process.exit(1);
}

/** CJK vs ASCII: if these disagree across runs, overlap is not comparable. */
function languageOf(text) {
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (text.match(/[a-zA-Z]/g) || []).length;
  return cn > en ? 'CN' : 'EN';
}

/**
 * Cut a review into POINTS — one per complaint, not one per sentence.
 *
 * This matters more than any threshold. A reply is structured as paragraphs:
 * claim, justification, then "见 §3, Theorem 3 证明". Splitting on sentence
 * punctuation turned each single complaint into 6–7 fragments, each of which
 * then looked like an independent finding. That inflated the unstable column
 * (46 "one-off" items from a 1959-character reply) and made every repeat look
 * like it agreed on almost nothing.
 *
 * So the unit is a block: split on blank lines, list markers, or the ordinal
 * lead-ins the model actually uses ("其次是", "第三是", "第四是"). The trailing
 * "see §X" sentence stays inside its block and contributes the locator, which
 * is how a locator gets attached to the complaint it belongs to.
 *
 * A point must carry a locator OR specific numbers/symbols, otherwise it cannot
 * be checked against the manuscript and cannot be acted on.
 *
 * Two kinds of block are dropped even though they look substantive:
 *
 * 1. FRAMING — "As a reviewer for IEEE TIE, I would organize my objection…".
 *    Perfectly reproducible across runs, which is exactly why such a block
 *    floats to the top of a stability count while saying nothing.
 * 2. LOCATOR-ONLY — "见 Theorem 3、Corollary 1。" Nothing but citations has no
 *    claim to be stable or unstable.
 */
const FRAMING = /^(?:作为|下面|以下是|首先|综上|总之|我会从|我将从|As an?\s|Below\b|Here\b|I would|My\b|In summary)/i;
const LEAD_IN = /[：:]\s*$/;
const LOCATOR_ONLY = /^(?:见|参见|详见|also\s+see|see\s+(?:also\s+)?)[\s\S]{0,140}$/i;

/** Everything that is punctuation, whitespace or a citation, nothing else. */
const STRIPPED = /(?:§\s*[\dIVX]+(?:-[A-Z])?|(?:Theorem|Lemma|Corollary|Proposition|Remark|Definition|Example|Assumption|Eq\.?|Equation|Section|Table|Fig\.?|Figure|Appendix)\s*[\dIVX]+(?:\(\w+\))?|式\s*\(\d+\)|及其证明|的证明|证明|[\s,，、;；:：.。()（）\-—–]|\band\b|和|及|与|等)/gi;

/** Block boundary: blank line, or a numbered/ordinal lead-in, or a list bullet. */
const BLOCK_BREAK =
  /\n\s*\n|\n?\s*(?=(?:第[一二三四五六七八九十]+[是点]|其[次他]是|再[次者]是|最后是|此外|另外|还有[一二三]?[、是]|\d+[.)、]\s|\*\*[^*]+\*\*[：:]))/g;

function isLocatorOnly(s) {
  if (!LOCATOR_ONLY.test(s)) return false;
  return s.replace(STRIPPED, '').trim().length < 4;
}

/**
 * A lead-in ends in a colon because the content is in the list that follows.
 * "一个不了解该课题的读者最可能误解的几点如下：" is flawlessly reproducible
 * across runs and carries zero information — it is a table of contents.
 */
function isLeadIn(s) {
  return LEAD_IN.test(s) || /(?:如下|以下几点|如下所示|以下几[点条])\s*$/.test(s);
}

function claims(reply) {
  const out = [];
  const text = String(reply ?? '').replace(/```[\s\S]*?```/g, '\n');
  for (const raw of text.split(BLOCK_BREAK)) {
    const s = String(raw ?? '')
      .replace(/^\s*(?:#{1,6}\s*)?(?:[>*+-]|\d+[.)])\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (Array.from(s).length < 20) continue;
    if (FRAMING.test(s)) continue;
    if (isLeadIn(s)) continue;
    if (isLocatorOnly(s)) continue;
    const anchors = anchorsOf(s);
    const tok = contentTokens(s);
    if (!anchors.length && tok.size < 6) continue;
    out.push({ text: s, anchors, tokens: tok });
  }
  return out;
}

/**
 * Cluster one paper's claims across BOTH runs and lenses.
 *
 * Repeating a lens is cheap and useful — it separates "the model said this once"
 * from "this lens says this every time". But repetition inside one lens can only
 * ever prove self-consistency: ask the same question twice and the same framing
 * comes back, including the same wrong framing. That is a paraphrase detector,
 * not a truth detector.
 *
 * So the unit of acceptance is the LENS, not the run. A finding is only worth
 * acting on when lenses with genuinely different questions — "how would you
 * reject this" and "which assumption is smuggled in" and "what would a stranger
 * misread" — independently arrive at it. Those prompts pull on different parts
 * of the manuscript, so agreement between them is much harder to fake than
 * agreement between two runs of one prompt.
 *
 * Each cluster tracks `lenses` and `runs` separately so the report can say
 * which, not just how many.
 *
 * @param {{lens:string, run:number, claims:{text:string,anchors:string[],tokens:Set<string>}[]}[]} units
 */
function clusterAll(units) {
  const allClaims = units.flatMap((u) => u.claims);
  const lensCount = new Set(units.map((u) => u.lens)).size;
  const paperLevel = paperLevelLocators(
    units.flatMap((u) => u.claims.map((c) => ({ ...c, run: u.lens }))),
    lensCount
  );
  const samePoint = makeSamePoint();
  const clusters = [];

  for (const u of units) {
    for (const c of u.claims) {
      const hit = clusters.find((cl) => samePoint(cl, c, paperLevel));
      if (hit) {
        hit.runs.add(`${u.lens}#${u.run}`);
        hit.lenses.add(u.lens);
        for (const a of c.anchors) if (!hit.anchors.includes(a)) hit.anchors.push(a);
        for (const t of c.tokens) hit.tokens.add(t);
        // Keep the most developed wording; the report truncates for display.
        if (c.text.length > hit.text.length) hit.text = c.text;
      } else {
        clusters.push({
          text: c.text,
          runs: new Set([`${u.lens}#${u.run}`]),
          lenses: new Set([u.lens]),
          anchors: [...c.anchors],
          tokens: new Set(c.tokens),
        });
      }
    }
  }
  return clusters;
}

/** @type {Map<string, {lens:string, label:string, reply:string, lang:string, tokens:number|null, file:string}[]>} */
const byLens = new Map();
const scoreRows = [];

for (const f of files) {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const paper = basename(dirname(String(j.paper ?? f)));
  for (const a of j.answers ?? []) {
    const key = `${paper}::${a.id}`;
    if (!byLens.has(key)) byLens.set(key, []);
    const reply = String(a.reply ?? '');
    byLens.get(key).push({
      lens: a.id,
      label: a.label ?? a.id,
      reply,
      lang: languageOf(reply),
      tokens: a.tokens ?? null,
      file: basename(f),
    });
    // Scores are recorded verbatim, never averaged.
    if (a.id === 'score' || a.id === 'score-dims') {
      const m = reply.match(/(\d+(?:\.\d+)?)\s*\/\s*10|总评[^\d]{0,12}(\d+(?:\.\d+)?)/);
      if (m) scoreRows.push({ lens: a.id, value: m[1] ?? m[2], file: basename(f), paper });
    }
  }
}

const minRuns = Number(values['min-runs']) || 2;
const minLenses = Number(values['min-lenses']) || 2;

/**
 * Group per paper, not per (paper, lens).
 *
 * Grouping by lens would be the wrong frame: the question is not "does this
 * lens repeat itself" but "do independent questions converge on this defect".
 */
const byPaper = new Map();
for (const [key, runs] of byLens) {
  const [paper] = key.split('::');
  if (!byPaper.has(paper)) byPaper.set(paper, []);
  byPaper.get(paper).push(...runs);
}

const groups = [];
for (const [paper, runs] of byPaper) {
  const langSet = [...new Set(runs.map((r) => r.lang))];

  // One unit per (lens, run) so the report can distinguish the two axes.
  const units = [];
  const seenRun = new Map();
  for (const r of runs) {
    const k = `${r.lens}`;
    const run = (seenRun.get(k) ?? 0) + 1;
    seenRun.set(k, run);
    units.push({ lens: r.lens, run, claims: claims(r.reply) });
  }

  const clusters = clusterAll(units);

  // Stable = reached by >= minLenses different lenses, and >= 2 runs overall.
  const stable = clusters.filter(
    (c) => c.lenses.size >= Math.min(minLenses, seenRun.size) && c.runs.size >= 2
  );
  // Repeated by one lens only: self-consistent, not yet corroborated.
  const repeated = clusters.filter((c) => c.runs.size >= 2 && !stable.includes(c));
  const single = clusters.filter((c) => c.runs.size === 1);

  groups.push({
    paper,
    lenses: [...seenRun.keys()],
    runs: runs.length,
    languages: langSet,
    mixedLanguage: langSet.length > 1,
    stable,
    repeated,
    single,
  });
}

// ---- report ---------------------------------------------------------------
const L = [];
L.push('# 多轮反馈汇总');
L.push('');
L.push(`- 输入：${files.length} 个 JSON（${[...new Set(groups.map((g) => g.paper))].join('、')}）`);
L.push(`- 镜头：${[...new Set(groups.flatMap((g) => g.lenses))].join('、')}`);
L.push(`- 「可接受」判据：**至少 ${minLenses} 个不同镜头**都提到，且合计出现 ≥ ${minRuns} 次`);
L.push('');
L.push('> 下面的条目是 DeepSeek 的原话片段，**未经核实**。问题是否成立、要不要改，由论文作者判断。');
L.push('');

if (scoreRows.length) {
  L.push('## 分数（原样列出，不做平均）');
  L.push('');
  L.push('| 镜头 | 文件 | 分数 |');
  L.push('| --- | --- | --- |');
  for (const s of scoreRows) L.push(`| ${s.lens} | ${s.file} | ${s.value}/10 |`);
  const vals = [...new Set(scoreRows.map((s) => s.value))];
  if (vals.length > 1) {
    L.push('');
    L.push(
      `> **同一稿的分数落在 ${vals.join(' / ')}。** 这不是稳定测量，别把它当结论；` +
        '看下面重复出现的问题。'
    );
  }
  L.push('');
}

for (const g of groups) {
  L.push(`## ${g.paper}（${g.lenses.length} 个镜头 × ${g.runs} 次运行）`);
  L.push('');
  L.push(`镜头：${g.lenses.map((l) => `\`${l}\``).join(' ')}`);
  L.push('');
  if (g.mixedLanguage) {
    L.push(
      `> ⚠ 这几组回复的语言不一致（${g.languages.join(' / ')}），` +
        '跨语言的重叠无法比较，请只在本语言内部看。'
    );
    L.push('');
  }

  L.push(
    `### 多个镜头都提到（≥${Math.min(minLenses, g.lenses.length)} 个镜头）： ${g.stable.length} 条`
  );
  L.push('');
  L.push('_这是唯一可以据以改稿的一栏：不同问法各自撞到了同一个问题。_');
  L.push('');
  for (const c of g.stable) {
    L.push(`- **${[...c.lenses].join(' / ')}** — ${c.text.slice(0, 500)}`);
  }
  if (!g.stable.length) L.push('_（无）_');
  L.push('');

  if (g.repeated.length) {
    L.push(`### 只有一个镜头反复提到：${g.repeated.length} 条`);
    L.push('');
    L.push('_内部一致，但没有第二个镜头佐证。可能是这个问法自带的执念。_');
    L.push('');
    for (const c of g.repeated) {
      L.push(`- **${[...c.lenses].join(' / ')}** — ${c.text.slice(0, 400)}`);
    }
    L.push('');
  }

  L.push(`### 只出现过一次：${g.single.length} 条`);
  L.push('');
  L.push('_未经核实，可能是真的也可能是一次性的。_');
  L.push('');
  L.push(`<details><summary>展开 ${g.single.length} 条</summary>`);
  L.push('');
  for (const c of g.single) {
    const who = [...c.lenses].join(' / ');
    L.push(`- \`${who}\` ${c.text.slice(0, 400)}`);
  }
  L.push('');
  L.push('</details>');
  L.push('');
}

const outMd = values.out
  ? resolve(values.out)
  : join(process.cwd(), '.deepseek-feedback', 'round-report.md');
mkdirSync(dirname(outMd), { recursive: true });
writeFileSync(outMd, L.join('\n'), 'utf8');

if (values.json) {
  console.log(JSON.stringify({ md: outMd, groups }, null, 2));
} else {
  console.log(L.join('\n'));
  console.error(`\n写入：${outMd}`);
}
