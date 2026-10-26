/**
 * Lenses — the fixed menu of questions used for divergence.
 *
 * Why a menu and not free-form prompts:
 *
 *  1. Repeat-asking the same model the same question returns correlated
 *     answers. A different *question* decorrelates far more than a second
 *     sample does.
 *  2. Every lens is a hardcoded constant, so the run is auditable and can be
 *     compared across rounds. A prompt typed on the fly is not reproducible.
 *  3. Each is capped at PROMPT_MAX characters, same as the scoring question.
 *
 * Adding a lens is a source edit on purpose: the menu is part of the method,
 * not a runtime knob.
 */

/** Hard cap, shared with `ask-paper.mjs`. Applies to ask + LANG_PIN combined. */
export const PROMPT_MAX = 50;

/**
 * Pin the reply language.
 *
 * Measured, not assumed: running the SAME lens on the SAME paper twice returned
 * one English review and one Chinese review. That ruins comparability — CJK
 * bigrams and ASCII words are disjoint token spaces, so any overlap measurement
 * between those two runs collapses to zero, and a reader comparing rounds sees
 * different prose for the same complaint.
 *
 * The prompts are Chinese, so the natural reply is Chinese; this just stops the
 * drift. It is appended by the caller, counts against PROMPT_MAX, and is not
 * configurable — same reason as everything else here: a fixed string makes runs
 * comparable, a knob does not.
 */
export const LANG_PIN = '请用中文回答。';

/**
 * Ask for a locator on every point.
 *
 * This is the one change that made grouping work. Clustering review PROSE
 * failed every control I ran: two runs of the same lens on the same paper
 * shared 5% of sentences, and symbol overlap was dominated by paper-level
 * boilerplate (`\lambda`, `2\times2`) that appears in half the claims. Rewording
 * is not noise to be filtered out — it is the normal output.
 *
 * A section or equation number is different: it is a fact about the manuscript,
 * so two reviews that flag the same defect tend to cite the same place, in the
 * same notation, regardless of phrasing. Asking for it costs 12 characters and
 * turns fuzzy string matching into equality testing.
 */
export const ANCHOR_PIN = '每条后标注章节或公式号。';

/**
 * @typedef {{id:string,label:string,ask:string,useWhen:string}} Lens
 */

/**
 * Journals for the reject-letter lenses.
 *
 * Why a table instead of a `--journal` flag: a flag would let the caller put
 * arbitrary text into the prompt, which is exactly what the 50-char hardcoded
 * rule exists to prevent. Adding a venue is a source edit, same as a lens.
 */
export const JOURNALS = [
  { id: 'tie', name: 'IEEE TIE' },
  { id: 'tpel', name: 'IEEE TPEL' },
  { id: 'tim', name: 'IEEE TIM' },
  { id: 'tcst', name: 'IEEE TCST' },
];

/**
 * Turn a venue into a lens that asks for a full rejection review.
 *
 * `reject` already asks where the ceiling is. This asks for the artifact a
 * reviewer would actually submit — which is a different answer shape: ranked
 * major concerns, citation of the offending equation, and a bottom line. On
 * the same manuscript the two disagreed on content, not just on tone.
 *
 * @param {{id:string,name:string}} journal
 * @returns {Lens}
 */
function rejectLetterLens(journal) {
  return {
    id: `reject-${journal.id}`,
    label: `${journal.name} 审稿人的拒稿信`,
    ask: `假如你是${journal.name}的审稿人，你将如何拒稿？`,
    useWhen: `想知道按 ${journal.name} 的口味，这稿会被写成什么样的审稿意见`,
  };
}

/** @type {Lens[]} */
export const LENSES = [
  {
    id: 'reject',
    label: '最可能被拒的理由',
    ask: '这篇论文最可能被拒稿的理由是什么？',
    useWhen: '想知道天花板在哪、最该先补哪块',
  },
  ...JOURNALS.map(rejectLetterLens),
  {
    id: 'probe',
    label: '审稿人最想追问的点',
    ask: '如果你是这个方向的审稿人，最想追问哪一点？',
    useWhen: '需要一个具体、可回答的质疑，而不是泛泛而谈',
  },
  {
    id: 'boundary',
    label: '适用边界',
    ask: '这个方法的适用边界在哪里？超出会怎样失效？',
    useWhen: '想给结论画出可信范围，防止过度外推',
  },
  {
    id: 'simpler',
    label: '更简单的替代解释',
    ask: '有没有更简单的替代解释能说明这些现象？',
    useWhen: '担心自己的解释是过拟合出来的故事',
  },
  {
    id: 'selfdeceive',
    label: '作者可能自欺之处',
    ask: '作者最可能在哪里说服了自己但没说服读者？',
    useWhen: '自查盲区，通常最难自己想到',
  },
  {
    id: 'transfer',
    label: '跨领域可迁移性',
    ask: '这个结论换一个领域还成立吗？哪里会先崩？',
    useWhen: '想把贡献说大一点，或评估普适性',
  },
  {
    id: 'novelty',
    label: '与已有工作的真正差异',
    ask: '和已有文献相比，真正新的东西只有哪一点？',
    useWhen: '贡献列表写得比实际强，需要压缩到一条',
  },
  {
    id: 'hides',
    label: '被隐藏的假设',
    ask: '这篇论文里最不该被默认成立的假设是哪个？',
    useWhen: '理论类章节自查，常常能挖出真的漏洞',
  },
  {
    id: 'reader',
    label: '读者第一眼的误解',
    ask: '一个不了解这个课题的读者会误解哪一点？',
    useWhen: '怀疑写作层面有问题、读者抓不住重点',
  },
  {
    id: 'next',
    label: '下一步最值得做的事',
    ask: '如果只有一个月，最该补哪一件事？',
    useWhen: '时间有限，要排优先级',
  },
  {
    id: 'score-dims',
    label: '逐方面打分',
    ask: '请给这篇论文打分，满分10分，各个方面打多少分',
    useWhen: '要一张分项表，而不是一个总分',
  },
  {
    id: 'top',
    label: '与顶刊高被引论文的差距',
    ask: '它和该期刊的顶尖高引优秀论文的区别是什么？',
    useWhen: '想知道"够格发表"和"被人反复引用"之间还隔着什么',
  },
  {
    id: 'sweep',
    label: '逐节排查',
    ask: '请逐节检查这篇论文，每节指出至少一个问题。',
    useWhen:
      '单次覆盖最高的一问。整体式提问往往只提 3–4 条就停，' +
      '逐节要求把"采样"换成"枚举"，实测单次覆盖 5/6 条已核实缺陷（整体式平均 3.0/6）',
  },
];

/**
 * Follow-ups. These are NOT standalone questions — they only make sense as a
 * second turn in the same chat session, because they refer to "上面".
 *
 * That is the whole point: a fresh session cannot answer "which of the above
 * did you not verify", so keeping the session is what makes these worth asking.
 * Measured: asked after a reject letter, the model went through its own 11
 * points and separated the ones it had checked against the tex from the ones
 * that were its own outside judgement. That distinction is the single most
 * useful thing a human needs before spending an afternoon on a rewrite.
 */
export const FOLLOWUPS = [
  {
    id: 'verify',
    label: '哪几条没核实过',
    ask: '上面哪几条你没有在原文中核实过？请单独列出。',
    useWhen: '把"原文事实"和"审稿人推断"分开，决定哪些要先自己查',
  },
  {
    id: 'evidence',
    label: '要行号和原句',
    ask: '上面最关键的那一条，请给出原文行号和原句。',
    useWhen: '要动笔改之前，先确认它说的东西真的在那',
  },
  {
    id: 'strongest',
    label: '只留一条',
    ask: '如果只能保留一条意见，你保留哪条？为什么？',
    useWhen: '意见太多、时间不够，要逼出一个优先级',
  },
  {
    id: 'counter',
    label: '哪条可能是误读',
    ask: '上面有哪条可能是我误读了原文？请指出。',
    useWhen: '怀疑自己被带偏了，让它自己找反证',
  },
];

export const FOLLOWUP_IDS = FOLLOWUPS.map((f) => f.id);

/** @param {string} id */
export function followupById(id) {
  const found = FOLLOWUPS.find((f) => f.id === id);
  if (!found) {
    throw new Error(`lenses: no follow-up "${id}". Known: ${FOLLOWUP_IDS.join(', ')}`);
  }
  return found;
}

/**
 * Throws at import time if any lens is over the cap.
 *
 * The cap covers the lens PLUS both pins, because they are sent as one message.
 * Measuring only the lens would let the combined prompt creep past 50.
 */
export const PINS = LANG_PIN + ANCHOR_PIN;

for (const lens of LENSES) {
  const n = Array.from(lens.ask).length;
  if (n > PROMPT_MAX) {
    throw new Error(
      `lenses: "${lens.id}" is ${n} characters, over the ${PROMPT_MAX}-character cap.`
    );
  }
  const total = Array.from(lens.ask + PINS).length;
  if (total > PROMPT_MAX) {
    throw new Error(
      `lenses: "${lens.id}" + pins is ${total} characters, over the ${PROMPT_MAX}-character cap.`
    );
  }
}

/** The text actually sent: the lens, then the language and anchor pins. */
export function promptFor(lens) {
  return lens.ask + PINS;
}

// Follow-ups are sent without the anchor pin: asking "which of the above did you
// not verify" and then demanding section numbers invites it to invent them.
for (const f of FOLLOWUPS) {
  const n = Array.from(f.ask).length;
  if (n > PROMPT_MAX) {
    throw new Error(
      `lenses: follow-up "${f.id}" is ${n} characters, over the ${PROMPT_MAX}-character cap.`
    );
  }
}

/** Where a point points to: `§IV-B`, `Eq.(12)`, `Table II`, `L112`. */
const ANCHOR_RE =
  /(?:§+\s*[\dIVX]+(?:[.\-–][A-Z0-9]+)*|(?:section|sec\.?|eq\.?|equation|table|fig\.?|figure|remark|theorem|lemma|corollary|appendix)\s*[\dIVX]+(?:\.\d+)*|\bL\d+(?:[–-]L?\d+)?)/gi;

/**
 * Extract the locators a point cites, normalised so that `§IV-B`,
 * `Section IV-B`, and `IV-B` all compare equal.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function anchorsOf(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(ANCHOR_RE)) {
    const raw = m[0].toLowerCase();
    const kindMatch = raw.match(
      /^(§|section|sec|eq|equation|table|fig|figure|remark|theorem|lemma|corollary|proposition|appendix)/
    );
    // The KIND must survive. Stripping it collapsed "Theorem 1" and "Eq. (1)"
    // into the same key, so on a short maths paper (where nearly every point
    // cites Theorem 1) every pair of points looked identical — measured as a
    // spurious flat 18% overlap.
    const kind = (kindMatch?.[1] ?? '')
      .replace(/^(section|sec)$/, 'sec')
      .replace(/^(eq|equation)$/, 'eq')
      .replace(/^(fig|figure)$/, 'fig')
      .replace(/^§$/, 'sec');

    const num = raw
      .replace(/^§\s*/, '')
      .replace(
        /^(?:section|sec|eq|equation|table|fig|figure|remark|theorem|lemma|corollary|proposition|appendix)\b\.?/,
        ''
      )
      .replace(/[\s.]+/g, '')
      .trim();
    if (!num) continue;
    out.add(kind ? `${kind}${num}` : num);
  }
  return [...out];
}

export const LENS_IDS = LENSES.map((l) => l.id);

/** @param {string} id */
export function lensById(id) {
  const found = LENSES.find((l) => l.id === id);
  if (!found) {
    throw new Error(`lenses: no lens "${id}". Known: ${LENS_IDS.join(', ')}`);
  }
  return found;
}

/** Resolve a comma list, `all`, or a single id. @param {string} spec */
export function resolveLensSpec(spec) {
  const s = (spec ?? '').trim();
  if (!s || s === 'all') return LENSES.slice();
  return s.split(',').map((x) => lensById(x.trim()));
}
