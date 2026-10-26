/**
 * Finding identity, v3 — with paper-level vocabulary removed.
 *
 * v2 got the language problem fixed but still matched garbage. The revealed
 * cause: rule "shared >= 2 identifiers" fired on `$2\times2$` and
 * `$\lambda=\max\{a,d,(b+c)/2\}$` — symbols that appear in HALF THE CLAIMS
 * about this paper. They identify the PAPER, not the CLAIM, so sharing them
 * says nothing. Same story for "theorem 1" on a seven-theorem manuscript.
 *
 * The fix is document frequency, not a better hand-written stoplist: an
 * identifier that shows up in more than a third of the claims in the same run
 * set is paper-level boilerplate and is dropped before matching. That is
 * computed from the data, so it adapts to emoji-free, number-free theory papers
 * as well as to measurements papers full of Ω and mH.
 */

const CJK = /[\u4e00-\u9fff]/;

const STOP = new Set(
  (
    'the a an and or but if then than that this these those there their its it is are was were be been being ' +
    'of in on at to for from by with without as not no nor so such which who whom whose what when where how ' +
    'we our you your they them he she his her has have had do does did can could should would may might must ' +
    'paper work study authors author manuscript reviewer review reviews ' +
    'also more most much many some any all both each other another same very only just even still yet ' +
    'however therefore because while although though since thus hence moreover furthermore addition ' +
    'one two three first second third ' +
    '这个 这篇 这些 那些 论文 作者 我们 你们 他们 一个 一种 一些 以及 而且 但是 因为 所以 如果 虽然 然后 这样 那样 ' +
    '可以 应该 需要 没有 不是 就是 已经 还是 或者 并且 因此 由于 对于 关于 通过 进行 存在 出现 导致 使得 认为 指出 ' +
    '问题 方面 情况 内容 部分 时候 地方 这里 那里 什么 怎么 如何 为什么 是否 非常 比较 更加 十分 相当 ' +
    '研究 工作 方法 结果 结论 分析 讨论 说明 表明 显示 提出 给出 采用 使用 实现 完成 得到 获得 ' +
    '本文 稿件 该稿 审稿 建议 认为 如果 因此 综上 总之 首先 其次 最后 此外 另外 同时'
  )
    .split(/\s+/)
    .filter(Boolean)
);

export function contentTokens(s) {
  const out = new Set();
  const t = String(s ?? '')
    .toLowerCase()
    .replace(/[`*_#>[\]]+/g, ' ');
  for (const m of t.matchAll(/[a-z][a-z0-9-]{2,}/g)) if (!STOP.has(m[0])) out.add(m[0]);
  const chars = Array.from(t).filter((c) => CJK.test(c));
  for (let i = 0; i + 1 < chars.length; i++) {
    const bg = chars[i] + chars[i + 1];
    if (!STOP.has(bg)) out.add(bg);
  }
  return out;
}

/** Raw identifiers, before document-frequency filtering. */
export function rawDistinctive(s) {
  const out = new Set();
  const t = String(s ?? '');
  for (const m of t.matchAll(/`([^`]{1,80})`/g)) out.add(m[1].toLowerCase().trim());
  for (const m of t.matchAll(/\$[^$\n]{1,60}\$/g)) out.add(m[0].toLowerCase().replace(/\s+/g, ''));
  for (const m of t.matchAll(/\\[a-zA-Z]{2,}/g)) out.add(m[0].toLowerCase());
  for (const m of t.matchAll(
    /\b(?:theorem|thm|lemma|corollary|proposition|section|sec|equation|eq|fig(?:ure)?|table|remark|definition|appendix)\s*\.?\s*(\d+(?:\.\d+)*)\b/gi
  )) {
    out.add(m[0].toLowerCase().replace(/[.\s]+/g, ''));
  }
  for (const m of t.matchAll(/\b\d+(?:[.,]\d+)?\s*(?:mH|μH|uH|Ω|ohm|ms|μs|us|kHz|Hz|mV|mA|GB|%|mT|V|A|s|K|bits?)\b/g)) {
    out.add(m[0].replace(/\s+/g, '').toLowerCase());
  }
  return out;
}

/**
 * Ratio of claims in this set that mention an identifier. Above the cutoff it is
 * paper-level vocabulary. 1/3 is deliberately generous: dropping a slightly
 * useful identifier costs one missed match, keeping boilerplate costs a false
 * merge on every pair, which is what wrecked v2.
 */
export const DF_CUTOFF = 1 / 3;

/**
 * Build a matcher bound to one run set, so document frequency is computed once.
 * @param {string[]} texts all claims that will be compared against each other
 */
export function makeMatcher(texts) {
  const n = Math.max(1, texts.length);
  const df = new Map();
  /** @type {Map<string, {tokens:Set<string>, distinct:Set<string>, text:string}>} */
  const cache = new Map();

  for (const t of texts) {
    for (const id of rawDistinctive(t)) df.set(id, (df.get(id) ?? 0) + 1);
  }

  /** Identifiers distinctive of a CLAIM: rare enough within this run set. */
  const keep = (id) => (df.get(id) ?? 0) / n <= DF_CUTOFF;

  function feature(text) {
    if (cache.has(text)) return cache.get(text);
    const distinct = new Set([...rawDistinctive(text)].filter(keep));
    const f = { text, tokens: contentTokens(text), distinct };
    cache.set(text, f);
    return f;
  }

  return {
    feature,
    droppedByDf: [...df.entries()].filter(([id, c]) => c / n > DF_CUTOFF).map(([id]) => id),
    dfSize: df.size,
  };
}

/** Containment of the shorter claim's content words inside the longer. */
export function containment(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

/**
 * Are two findings the same complaint?
 *
 * Conjunctive, after a failed disjunctive version. The disjunction let
 * "shared >= 2 identifiers" decide alone, and on a maths paper `\lambda` and
 * `\max` appear in nearly every claim — so two unrelated sentences about
 * different theorems "matched" on generic symbols (measured: c=0.19, matched).
 * An identifier is only evidence when the surrounding prose agrees too.
 *
 *   strong: >= 2 rare identifiers AND content containment >= 0.35
 *   weak:   >= 1 rare identifier  AND content containment >= 0.50
 *   prose: content containment >= 0.70 (reworded, no symbols shared)
 */
export const SAME_CONTAINMENT = 0.70;
export const WEAK_CONTAINMENT = 0.50;
export const STRONG_CONTAINMENT = 0.35;

export function sameFinding(a, b) {
  let shared = 0;
  for (const x of a.distinct) if (b.distinct.has(x)) shared++;
  const c = containment(a.tokens, b.tokens);
  if (shared >= 2 && c >= STRONG_CONTAINMENT) return true;
  if (shared >= 1 && c >= WEAK_CONTAINMENT) return true;
  return c >= SAME_CONTAINMENT;
}
