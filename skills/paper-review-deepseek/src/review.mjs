/**
 * The review pipeline itself.
 *
 * Transport is injected (`complete`, `uploadFile`) so this module owns the
 * *process* — attach once, fan out, score, merge — while the caller owns the
 * *plumbing*. That split is what lets the same pipeline run behind an MCP tool
 * and behind a plain CLI without two copies drifting apart.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { PERSONAS } from './personas.mjs';
import {
  DIMENSIONS,
  aggregateScores,
  parseScores,
  renderScorecard,
  SCORE_BLOCK_INSTRUCTION,
} from './rubric.mjs';

export const DEFAULT_TIMEOUT_MS = 600_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The web backend accepts roughly two requests in flight and answers with an
 * empty stream beyond that, so an empty reply is treated as "retry", not as a
 * genuine empty answer.
 */
export async function completeRetry(complete, opts, { attempts = 3, label = 'request' } = {}) {
  let lastErr;
  for (let a = 1; a <= attempts; a += 1) {
    try {
      const r = await complete(opts);
      if (r.text && r.text.trim()) return r;
      lastErr = new Error('empty reply');
      if (a < attempts) await sleep(1200 * a);
    } catch (e) {
      lastErr = e;
      if (a < attempts) await sleep(1500 * a);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr?.message ?? lastErr}`);
}

export async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

const reviewerPrompt = (persona) =>
  [
    persona.brief,
    '',
    '论文已作为附件发给你（LaTeX 源码），请先通读附件再作答。',
    '',
    '输出要求：',
    '- 用中文回答。',
    '- Markdown，从二级标题 `## ` 开始，不要复述你的角色。',
    '- 具体、可执行：指出章节号/公式号/表号，引用原文短语。',
    '- 只输出评审意见，不要客套话。',
    '- 篇幅 600–1200 字。',
    '',
    SCORE_BLOCK_INSTRUCTION,
  ].join('\n');

const synthesisPrompt = ({ dossier, scorecard }) =>
  [
    '你是负责汇总评审意见的主编。下面是多位独立审稿人对同一篇论文的意见（互相看不到对方）。',
    '论文附件同前，可作为核对依据。',
    '',
    ...(scorecard
      ? [
          '各审稿人已按 8 个维度打过分（1–10），汇总如下（中位数、区间、分歧 σ）：',
          ...scorecard.rows.map(
            (r) =>
              `- ${r.label}: 中位 ${r.median ?? '—'}（${r.min ?? '—'}–${r.max ?? '—'}，` +
              `σ=${r.spread ?? '—'}，权重 ${r.weight}）`
          ),
          `加权总分（中位数合成）：${scorecard.total} / 10 → ${scorecard.verdict}`,
          '',
          '请在第 2 条之后额外用一节 **评分分歧解读**：哪些维度分歧大（σ≥2）、' +
            '为什么会有这种分歧、作者应按哪一方处理。分歧不是噪声，是真正的争议点。',
          '',
        ]
      : []),
    '请产出给作者看的**合并评审报告**：',
    '1. 先用 3–5 句给出总体判断（现状与最大风险）。',
    '2. **共识问题**：两位及以上独立指出同一问题的，按"不修会不会被拒"排序，注明由谁提出。',
    '3. **单点但严重的问题**：只有一位提出但足以致命。',
    '4. **可直接核对的事实性问题**：数字冲突、前后不一致、引用错误，要求作者逐条核对。',
    '5. **优先级修复清单**（P0/P1/P2），每条一句话可执行。',
    '6. 最后一句回答：本文最大卖点是否站得住。',
    '',
    '中文，Markdown，归并去重、不要复述原文。篇幅 1200–2000 字。',
    '',
    '=== 审稿意见 ===',
    dossier,
    '=== 结束 ===',
  ].join('\n');

const stripScoreFence = (s) => s.replace(/```(?:score|json)?\s*\{[\s\S]*?\}\s*```/g, '').trim();

const scoreLine = (scores) =>
  scores
    ? Object.entries(scores)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')
    : '未给出可解析的分数';

/**
 * Upload the manuscript once, run N independent reviewers, score them, merge.
 *
 * `personaOverrides` lets a caller swap in its own reviewer list (the MCP tool
 * exposes a count, the CLI exposes ids) without changing the pipeline.
 */
export async function runPaperReview({
  texPath,
  outPath,
  personas = 5,
  thinking = false,
  concurrency = 2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  chosen,
  label = 'paper-review',
  // injected transport
  complete,
  uploadFile,
  onProgress = () => {},
}) {
  const picked = chosen?.length ? chosen : PERSONAS.slice(0, Math.max(1, Math.min(6, personas)));

  const file = await uploadFile(texPath);
  if (file.status !== 'SUCCESS') {
    const err = new Error(`Upload did not finish parsing: status=${file.status} id=${file.id}`);
    err.file = file;
    throw err;
  }
  onProgress({ stage: 'uploaded', file });

  const report = outPath ?? join(dirname(texPath), 'deepseek-review-report.md');
  const cacheDir = join(dirname(report), '.deepseek-review');
  await mkdir(cacheDir, { recursive: true });

  const results = [];
  await pMap(picked, concurrency, async (persona, idx) => {
    const t0 = Date.now();
    onProgress({ stage: 'start', persona: persona.id, index: idx });

    const r = await completeRetry(
      complete,
      {
        prompt: reviewerPrompt(persona),
        thinking,
        search: false,
        refFileIds: [file.id],
        timeoutMs,
      },
      { label: persona.id }
    );

    const item = {
      ...persona,
      text: r.text.trim(),
      scores: parseScores(r.text),
      ms: Date.now() - t0,
      tokens: r.tokens,
      sessionId: r.sessionId,
    };
    results[idx] = item;

    await writeFile(
      join(cacheDir, `${persona.id}.md`),
      `# ${persona.title}\n\n` +
        `_model: ${r.tokens} tokens, ${item.ms}ms, session ${r.sessionId}_\n\n` +
        `_scores: ${item.scores ? JSON.stringify(item.scores) : 'n/a'}_\n\n` +
        `${item.text}\n`,
      'utf8'
    );

    onProgress({ stage: 'done', persona: persona.id, scores: item.scores, ms: item.ms });
    return item;
  });

  const done = results.filter(Boolean);
  const graders = done.filter((r) => r.scores);
  const scorecard = graders.length ? aggregateScores(graders) : null;

  const dossier = done.map((r, i) => `### 评审 ${i + 1}：${r.title}\n\n${r.text}`).join('\n\n');

  onProgress({ stage: 'synthesis' });
  const synth = await completeRetry(
    complete,
    {
      prompt: synthesisPrompt({ dossier, scorecard }),
      thinking,
      search: false,
      refFileIds: [file.id],
      timeoutMs,
    },
    { label: 'synthesis' }
  );

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    '# DeepSeek 多路评审报告',
    '',
    `- 论文：\`${texPath}\``,
    `- 附件 id：\`${file.id}\`（${file.tokens} tokens，${file.size} bytes）`,
    `- 生成时间：${stamp}`,
    `- 评审路数：${done.length} 位独立审稿人 + 1 次主编汇总`,
    `- 通道：DeepSeek 网页会话额度（未走按量计费 API）`,
    `- 深度思考：${thinking ? '开' : '关'}`,
    '',
    '---',
    '',
  ];

  if (scorecard) {
    lines.push(renderScorecard(scorecard, { heading: '## 一、评分卡（8 维度，满分 10）' }));
    lines.push(
      `\`${graders.length}/${done.length}\` 位审稿人给出了可解析的分数。` +
        '每位审稿人独立打分、互相看不到对方；头条分取**中位数**，区间与 σ 反映分歧。',
      '',
      '---',
      '',
      '## 二、主编汇总',
      '',
      synth.text.trim(),
      '',
      '---',
      '',
      '## 三、各审稿人原始意见',
      ''
    );
  } else {
    lines.push('## 一、主编汇总', '', synth.text.trim(), '', '---', '', '## 二、各审稿人原始意见', '');
  }

  for (const r of done) {
    lines.push(`### ${r.title}`, '');
    lines.push(`<sub>${r.tokens} tokens · ${(r.ms / 1000).toFixed(1)}s · session ${r.sessionId}</sub>`, '');
    lines.push(`<sub>评分：${scoreLine(r.scores)}</sub>`, '');
    lines.push(stripScoreFence(r.text), '');
  }

  lines.push('---', '');
  lines.push(
    `> 由 \`${label}\` 生成：文件上传一次、按 id 附给每位审稿人；各审稿人独立会话互不可见，主编再归并去重。`
  );
  lines.push(`> 评分维度：${DIMENSIONS.map((d) => `${d.label}(${d.weight})`).join(' / ')}，满分 10。`);

  await writeFile(report, lines.join('\n'), 'utf8');
  onProgress({ stage: 'written', report });

  return {
    report,
    file,
    reviews: done,
    graders: graders.length,
    scorecard,
    synthesis: synth.text.trim(),
    scoreSummary: scorecard ? `${scorecard.total} / 10 → ${scorecard.verdict}` : null,
    basename: basename(texPath),
  };
}

/** One-paragraph, paste-friendly summary of a run. */
export function summarizeRun(res) {
  const out = [
    `Reviewed \`${res.basename}\` with ${res.reviews.length} reviewers.`,
    `attachment: ${res.file.id} (${res.file.tokens} tokens)`,
    `report: ${res.report}`,
    '',
    `--- 加权总分：${res.scoreSummary ?? '（本次未取得可解析的评分）'} ---`,
  ];
  if (res.scorecard) {
    for (const r of res.scorecard.rows) {
      if (r.median == null) continue;
      out.push(`  ${r.label}: ${r.median}（${r.min}–${r.max}）${r.spread >= 2 ? ' ⚠️分歧' : ''}`);
    }
  }
  out.push('', '--- 主编汇总 ---', res.synthesis);
  return out.join('\n');
}
