/**
 * Scoring rubric for manuscript review.
 *
 * Why a fixed rubric instead of free-form "rate it" — an unanchored number is
 * noise: two reviewers both say "6" and mean opposite things. Every dimension
 * below carries anchors, so a 6 always means the same thing, and the spread
 * across reviewers becomes a real signal (wide spread = contested judgement,
 * not sloppy grading).
 *
 * Scores are 1–10 integers. Nothing here is a percentage.
 */

export const MAX_SCORE = 10;

export const DIMENSIONS = [
  {
    id: 'novelty',
    label: '原创性与贡献度',
    weight: 1.5,
    question: '这篇论文相对已有文献，真正新增的东西是什么？是发现还是重新命名？',
    anchors: {
      1: '结论已被现有文献完整覆盖，没有新增内容。',
      3: '有想法，但本质是对已知结论的重新包装或换场景重复。',
      5: '有一定新意，增量清晰但幅度有限；读者会认为"合理但不够意外"。',
      7: '有明确、可陈述的新贡献，同领域会引用。',
      9: '提出了新的问题框架或新的失效类别，明显改变本领域的讨论方式。',
    },
  },
  {
    id: 'rigor',
    label: '理论严谨性',
    weight: 1.5,
    question: '定义是否自洽？定理与证明是否成立？核心概念与既有概念的边界是否真的被分离？',
    anchors: {
      1: '定义互相矛盾或证明有致命漏洞。',
      3: '证明只覆盖特例，核心概念边界与既有概念重叠且未处理。',
      5: '论证基本成立，但存在未声明的假设或个别步跳过。',
      7: '定义清晰、证明完整，边界划分有说服力。',
      9: '形式化彻底，判据可证伪，边界与特例都被显式处理。',
    },
  },
  {
    id: 'method',
    label: '方法与实验设计',
    weight: 1,
    question: '实验/仿真是否设计得能真正检验主张？对照是否公平？变量是否被隔离？',
    anchors: {
      1: '实验无法支持任何结论，或明显混淆变量。',
      3: '有实验，但对照缺失、变量混杂，结论无法归因到声称的原因。',
      5: '实验基本合理，但缺少关键消融或对照。',
      7: '设计干净、变量隔离、有消融、有对照。',
      9: '能主动证伪自己的主张，包含跨平台/跨场景的独立验证。',
    },
  },
  {
    id: 'evidence',
    label: '证据强度与统计',
    weight: 1.25,
    question: '每处 claim 是否有对应证据？数字是否自洽？不确定度是否量化？阈值是否有依据？',
    anchors: {
      1: '关键数字在摘要/表/图/正文互相矛盾，无不确定度。',
      3: '数字大体存在但口径不统一，结论强度远超证据。',
      5: '证据够支撑主结论，但个别处过度声称或统计口径不清。',
      7: 'claim 与证据逐条对得上，误差与样本量交代清楚。',
      9: '给出置信区间、失效条件与负结果，读者能自行判断可信度。',
    },
  },
  {
    id: 'reproducibility',
    label: '可复现性',
    weight: 0.75,
    question: '照这篇文章，别人能否重建实验？缺什么？',
    anchors: {
      1: '关键参数与流程完全缺失。',
      3: '有描述但缺宏定义/代码/原始数据，重建会卡住。',
      5: '主要步骤可复现，个别细节需联系作者。',
      7: '参数、代码、数据齐备，另一组能独立复现。',
      9: '附带可执行脚本与原始记录，复现是自动化的一步。',
    },
  },
  {
    id: 'writing',
    label: '写作与组织',
    weight: 0.75,
    question: '结构是否清晰？主张是否前置？术语是否一致？图表是否承担论证职责？',
    anchors: {
      1: '读不懂，结构混乱。',
      3: '能读，但主线被淹没，术语不一致，图表与正文脱节。',
      5: '结构合理，个别段落冗余或含糊。',
      7: '清晰、克制、每个图表都在论证链上。',
      9: '几乎不需要编辑，叙述本身就在推进论证。',
    },
  },
  {
    id: 'fit',
    label: '期刊适配度',
    weight: 1,
    question: '这篇论文投目标期刊合适吗？读者会用吗？',
    anchors: {
      1: '投错期刊。',
      3: '沾边，但目标读者不会关心这个问题。',
      5: '基本对口，但需要压缩或调整侧重。',
      7: '明确对口，读者群会引用。',
      9: '正是该刊最想要的那类文章。',
    },
  },
  {
    id: 'robustness',
    label: '抗攻击性',
    weight: 1,
    question: '面对最不友好的审稿人追问，这篇文章站得住吗？',
    anchors: {
      1: '一个追问就能推翻主结论。',
      3: '有几个明显可被攻击但作者未回应的点。',
      5: '主要软肋可辩护，个别地方会答不上来。',
      7: '常见攻击都已预先回应。',
      9: '红队也找不出致命问题。',
    },
  },
];

export const DIMENSION_IDS = DIMENSIONS.map((d) => d.id);

/** Verdict bands derived from the weighted total, not chosen by the model. */
export const VERDICT_BANDS = [
  { min: 8.0, verdict: '接收（minor revision at most）' },
  { min: 6.5, verdict: '小修后可接收' },
  { min: 5.0, verdict: '大修后重投' },
  { min: 3.5, verdict: '拒稿，但方向可救' },
  { min: 0, verdict: '拒稿' },
];

export function verdictFor(total) {
  return VERDICT_BANDS.find((b) => total >= b.min)?.verdict ?? '拒稿';
}

/** The block we ask every reviewer to append; parsed back out of the reply. */
export const SCORE_BLOCK_INSTRUCTION = [
  '在评审意见的**最后**，附上一个 JSON 代码块，给这篇论文的 8 个维度打分（整数 1–10，满分 10）。',
  '只打分，不要在 JSON 里写评语。格式必须严格如下（键名固定，不要增删）：',
  '',
  '```score',
  JSON.stringify(Object.fromEntries(DIMENSION_IDS.map((id) => [id, 0])), null, 0),
  '```',
  '',
  '各维度的含义与档位：',
  ...DIMENSIONS.map(
    (d) =>
      `- \`${d.id}\`（${d.label}）：${d.question} ` +
      `档位参考 1=${d.anchors[1]} / 3=${d.anchors[3]} / 5=${d.anchors[5]} / 7=${d.anchors[7]} / 9=${d.anchors[9]}`
  ),
].join('\n');

/**
 * Pull the score block out of a reviewer's reply.
 *
 * Accepts ```score {...}```, ```json {...}```, or a bare trailing object; returns
 * null when nothing usable is found rather than inventing numbers.
 */
export function parseScores(reply) {
  if (!reply) return null;
  const fences = [...reply.matchAll(/```(?:score|json)?\s*(\{[\s\S]*?\})\s*```/g)];
  const candidates = [...fences.map((m) => m[1])];

  // Fallback: the last brace-balanced object in the text.
  const tail = reply.lastIndexOf('{');
  if (tail !== -1) {
    const close = reply.indexOf('}', tail);
    if (close !== -1) candidates.push(reply.slice(tail, close + 1));
  }

  for (const raw of candidates.reverse()) {
    try {
      const obj = JSON.parse(raw);
      const out = {};
      let hit = 0;
      for (const id of DIMENSION_IDS) {
        const v = obj[id];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= MAX_SCORE) {
          out[id] = Math.round(v);
          hit += 1;
        }
      }
      if (hit >= Math.ceil(DIMENSION_IDS.length / 2)) return out;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export function weightedTotal(scores) {
  if (!scores) return null;
  let sum = 0;
  let wsum = 0;
  for (const d of DIMENSIONS) {
    const v = scores[d.id];
    if (typeof v !== 'number') continue;
    sum += v * d.weight;
    wsum += d.weight;
  }
  return wsum ? Number((sum / wsum).toFixed(2)) : null;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(1));
};

const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Number(Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)).toFixed(2));
};

/**
 * Combine every reviewer's scores.
 *
 * Median is the headline (a single harsh or lenient reviewer cannot move it);
 * the spread is reported alongside so a contested dimension is visible rather
 * than averaged into a bland middle.
 */
export function aggregateScores(perReviewer) {
  const rows = [];
  for (const d of DIMENSIONS) {
    const values = perReviewer.map((r) => r.scores?.[d.id]).filter((v) => typeof v === 'number');
    if (!values.length) {
      rows.push({ ...d, n: 0, median: null, min: null, max: null, spread: null });
      continue;
    }
    rows.push({
      id: d.id,
      label: d.label,
      weight: d.weight,
      n: values.length,
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values),
      spread: stdev(values),
      values,
    });
  }

  const perReviewerTotals = perReviewer
    .map((r) => ({ who: r.title, total: weightedTotal(r.scores) }))
    .filter((x) => x.total != null);

  const medians = Object.fromEntries(rows.filter((r) => r.median != null).map((r) => [r.id, r.median]));
  const total = weightedTotal(medians);
  const totals = perReviewerTotals.map((x) => x.total);

  return {
    rows,
    perReviewerTotals,
    total,
    verdict: total == null ? null : verdictFor(total),
    totalRange: totals.length ? { min: Math.min(...totals), max: Math.max(...totals), spread: stdev(totals) } : null,
  };
}

/** Markdown scorecard, renderable straight into the report. */
export function renderScorecard(agg, { heading = '## 评分卡（8 维度，满分 10）' } = {}) {
  if (!agg?.total) return `${heading}\n\n（本次未取得可解析的评分。）\n`;
  const out = [heading, ''];
  out.push('| 维度 | 中位分 | 区间 | 分歧(σ) | 权重 |');
  out.push('| --- | ---: | :---: | ---: | ---: |');
  for (const r of agg.rows) {
    if (r.median == null) {
      out.push(`| ${r.label} | — | — | — | ${r.weight} |`);
      continue;
    }
    const flag = r.spread >= 2 ? ' ⚠️' : '';
    out.push(`| ${r.label} | **${r.median}** | ${r.min}–${r.max} | ${r.spread}${flag} | ${r.weight} |`);
  }
  out.push('');
  out.push(
    `**加权总分：${agg.total} / 10** → ${agg.verdict}` +
      (agg.totalRange
        ? `（各审稿人独立总分区间 ${agg.totalRange.min}–${agg.totalRange.max}，σ=${agg.totalRange.spread}）`
        : '')
  );
  if (agg.rows.some((r) => r.spread >= 2)) {
    out.push('', '> ⚠️ 标记的维度上审稿人分歧较大（σ≥2），建议作者按"争议点"而非"平均分"来处理。');
  }
  out.push('');
  return out.join('\n');
}
