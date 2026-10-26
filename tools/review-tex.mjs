/**
 * Run a LaTeX manuscript past several independent DeepSeek reviewers and write
 * one merged report.
 *
 * Each reviewer gets its own conversation and its own lens, so the critiques
 * are genuinely independent rather than one prompt asked five times. Results
 * are streamed to disk as they land, so an interrupted run keeps its work.
 *
 *   node tools/review-tex.mjs <paper.tex> [-o report.md] [--personas 5] [--thinking]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { complete } from '../src/client.mjs';

/* --------------------------------------------------------------- personas */

const PERSONAS = [
  {
    id: 'theory',
    title: '理论严谨性 / 可辨识性',
    brief: `你是一位专攻系统辨识与可辨识性理论（structural / practical / sampled-data identifiability）的资深审稿人。
请只从**理论严谨性**角度审阅：定义是否自洽、定理与证明是否成立、概念之间的边界（结构非可辨识 vs 实际非可辨识 vs 你提出的第三类）是否真的被分离、是否存在循环论证或隐含假设、"零"的判定是否可证伪。
不要评论写作风格、不要评论实验细节、不要提修改排版。`,
  },
  {
    id: 'experiment',
    title: '实验设计与统计',
    brief: `你是一位以实验严谨性著称的审稿人，熟悉电力电子与嵌入式测量的实验方法。
请只从**实验设计与统计**角度审阅：样本量/窗口数是否自洽、估计器比较是否公平、误差与不确定度是否量化、对照是否充分、可复现信息是否足够、数字在不同位置（摘要/表/图/正文）是否一致。
请具体指出数字冲突（列出你看到的矛盾数值）。不要评论理论框架、不要提排版。`,
  },
  {
    id: 'argument',
    title: '论证链与主张-证据一致性',
    brief: `你是一位以"砍主张"闻名的严格编辑。
请只审阅**论证链**：标题、摘要、引言承诺了什么，正文是否兑现；每一处 claim 是否有对应证据；有没有过度声称（overclaiming）、有没有把相关性说成因果、有没有把"新命名"包装成"新发现"。
请逐条列出"声称 → 是否有支撑 → 问题"。不要评论具体数值、不要提排版。`,
  },
  {
    id: 'journal',
    title: '期刊适配与贡献度',
    brief: `你是 IEEE Transactions on Industrial Electronics 的副编辑。
请只评估**期刊适配性与贡献度**：这篇文章相对已有文献的真正增量是什么、是否够 TIE 的门槛、读者会不会用、可推广性如何、需要补什么实验或分析才能达到接收标准。
请给出明确判断（接收/小修/大修/拒稿）并说明理由。不要逐句挑错。`,
  },
  {
    id: 'adversary',
    title: '反方审稿人（红队）',
    brief: `你是最不友好的那位审稿人。你的任务是**尽力找出能让这篇文章被拒的致命问题**。
请只做红队：找出最可能被攻击的弱点、最经不起追问的假设、最容易被同行指出的漏洞。每条都要写成"如果我问 X，作者可能答不上来，因为 Y"。
不要给出改进建议、不要说优点。`,
  },
  {
    id: 'reproduce',
    title: '可复现性与工程落地',
    brief: `你是负责复现性审查的审稿人，会真的照着文章去做。
请只审阅**可复现性**：照着这篇文章能否重建实验？缺哪些参数、宏定义、代码、数据？"Reproduction"一节是否真的够？读者拿到仓库后第一步会卡在哪里？
请列成清单。不要评论理论、不要提排版。`,
  },
];

/* ---------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Map with a hard concurrency cap. The backend tolerates ~2 in flight. */
async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The backend occasionally accepts a request and streams nothing. Retry those. */
async function completeWithRetry(opts, { attempts = 3, label = '' } = {}) {
  let lastErr;
  for (let a = 1; a <= attempts; a += 1) {
    try {
      const r = await complete(opts);
      if (r.text && r.text.trim().length > 0) return r;
      lastErr = new Error('empty reply');
      if (a < attempts) await sleep(1500 * a);
    } catch (e) {
      lastErr = e;
      if (a < attempts) await sleep(2000 * a);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr?.message ?? lastErr}`);
}

/** Strip LaTeX comments and collapse blank-line runs to save context. */
function tidyTex(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*%/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/* ------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
const texPath = argv.find((a) => !a.startsWith('-') && a !== argv[argv.indexOf('-o') + 1]);
if (!texPath) {
  console.error('usage: node tools/review-tex.mjs <paper.tex> [-o report.md] [--personas N] [--thinking] [--concurrency N]');
  process.exit(2);
}

const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
};
const outPath = flag('-o', join(dirname(resolve(texPath)), 'deepseek-review-report.md'));
const wantThinking = argv.includes('--thinking');
const concurrency = Number(flag('--concurrency', 2));

const raw = await readFile(texPath, 'utf8');
const tex = tidyTex(raw);
const title = /\\title\{([^}]*)\}/.exec(raw)?.[1]?.replace(/\\\\/g, ' ').trim() ?? basename(texPath);

console.log(`paper   : ${texPath}`);
console.log(`title   : ${title}`);
console.log(`size    : ${raw.length} chars (tidied ${tex.length})`);
console.log(`output  : ${outPath}`);
console.log(`thinking: ${wantThinking}   concurrency: ${concurrency}`);
console.log('');

const results = [];

const runOne = async (persona, idx) => {
  const prompt = [
    persona.brief,
    '',
    '下面是论文的完整 LaTeX 源码。请通读后再作答。',
    '',
    '输出要求：',
    '- 用中文回答。',
    '- 用 Markdown，从二级标题 `## ` 开始，不要再复述你的角色。',
    '- 具体、可执行：指出章节号/公式号/表号，引用原文短语。',
    '- 只输出你的评审意见，不要客套话、不要总结你的角色。',
    '- 篇幅 600–1200 字。',
    '',
    '=== BEGIN PAPER ===',
    tex,
    '=== END PAPER ===',
  ].join('\n');

  const t0 = Date.now();
  const r = await completeWithRetry(
    { prompt, thinking: wantThinking, search: false },
    { label: persona.id }
  );
  const item = {
    ...persona,
    text: r.text.trim(),
    reasoning: r.reasoning,
    ms: Date.now() - t0,
    tokens: r.tokens,
    sessionId: r.sessionId,
  };
  results[idx] = item;

  // Persist immediately so an interrupted run is not wasted.
  await mkdir(join(dirname(outPath), '.deepseek-review'), { recursive: true });
  await writeFile(
    join(dirname(outPath), '.deepseek-review', `${persona.id}.md`),
    `# ${persona.title}\n\n_model: ${r.tokens} tokens, ${item.ms}ms, session ${r.sessionId}_\n\n${item.text}\n`,
    'utf8'
  );

  console.log(`[${idx + 1}/${PERSONAS.length}] ${persona.title.padEnd(18)} ${item.ms}ms ${r.text.length} chars`);
  return item;
};

const personas = PERSONAS.slice(0, Number(flag('--personas', PERSONAS.length)));
await pMap(personas, concurrency, runOne);

/* -------------------------------------------------------------- synthesis */

console.log('\nsynthesising ...');
const dossier = results
  .filter(Boolean)
  .map((r, i) => `### 评审 ${i + 1}：${r.title}\n\n${r.text}`)
  .join('\n\n');

const synthPrompt = [
  '你是负责汇总评审意见的主编。下面是多位独立审稿人对同一篇论文的意见（他们互相看不到对方的意见）。',
  '',
  '请产出一份给作者看的**合并评审报告**，要求：',
  '1. 先用 3–5 句给出总体判断（这篇论文现在的状态、最大风险）。',
  '2. 列出**共识问题**：两位及以上审稿人独立指出同一问题的，按"如果不修会不会被拒"排序。每条注明是哪几位审稿人提出的。',
  '3. 列出**单点但严重的问题**：只有一位提出，但你觉得足以致命。',
  '4. 列出**可直接核对的事实性问题**：数字冲突、前后不一致、引用错误等，要求作者逐条核对。',
  '5. 给出**优先级修复清单**（P0 必须修 / P1 应该修 / P2 可选），每条一句话可执行。',
  '6. 最后用一句话回答：这篇论文现在的最大卖点是否站得住。',
  '',
  '用中文，Markdown，不要复述审稿人原文，要归并去重。篇幅 1200–2000 字。',
  '',
  '=== 审稿意见 ===',
  dossier,
  '=== 结束 ===',
].join('\n');

const synth = await completeWithRetry(
  { prompt: synthPrompt, thinking: wantThinking, search: false },
  { label: 'synthesis' }
);

/* ------------------------------------------------------------------ write */

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
const lines = [
  `# DeepSeek 多路评审报告`,
  '',
  `- 论文：\`${texPath}\``,
  `- 标题：${title}`,
  `- 源码规模：${raw.length} 字符（约 ${Math.round(raw.length / 3.5)} tokens）`,
  `- 生成时间：${stamp}`,
  `- 评审路数：${results.filter(Boolean).length} 位独立审稿人 + 1 次主编汇总`,
  `- 通道：DeepSeek 网页会话额度（未走按量计费 API）`,
  `- 深度思考：${wantThinking ? '开' : '关'}`,
  '',
  '---',
  '',
  '## 一、主编汇总',
  '',
  synth.text.trim(),
  '',
  '---',
  '',
  '## 二、各审稿人原始意见',
  '',
];

for (const r of results.filter(Boolean)) {
  lines.push(`### ${r.title}`, '');
  lines.push(`<sub>${r.tokens} tokens · ${(r.ms / 1000).toFixed(1)}s · session ${r.sessionId}</sub>`, '');
  lines.push(r.text, '');
}

lines.push('---', '');
lines.push(
  `> 本报告由 \`deepseek-web-mcp\` 的评审流程自动生成：每位审稿人各自开一个独立会话读完论文全文后作答，互不可见；主编再对全部意见归并去重。`
);

await writeFile(outPath, lines.join('\n'), 'utf8');
console.log(`\nwrote ${outPath}`);
console.log(`synthesis tokens=${synth.tokens} ${synth.elapsedMs}ms`);
