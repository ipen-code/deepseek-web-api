#!/usr/bin/env node
/**
 * deepseek-web-mcp — MCP server that talks to chat.deepseek.com through the
 * user's own logged-in web session.
 *
 * No API key. No per-token billing. No browser window at run time.
 *
 * Documents travel as real attachments: the file is uploaded once with
 * `uploadFile()`, and every later question references it by `file-` id. That is
 * what the web UI itself does, and it is strictly better than pasting LaTeX into
 * the prompt — the model gets a filename, the parse happens once, and long
 * manuscripts do not have to be re-typed into every message.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  complete,
  createSession,
  listSessions,
  loadToken,
  tokenPath,
  DeepSeekError,
  BASE,
} from './src/client.mjs';
import { solveChallenge } from './src/pow.mjs';
import { uploadFile, uploadFiles, fetchFiles } from './src/files.mjs';
import {
  aggregateScores,
  parseScores,
  renderScorecard,
  SCORE_BLOCK_INSTRUCTION,
  DIMENSIONS,
} from './src/rubric.mjs';

const SERVER_INFO = { name: 'deepseek-web', version: '0.2.0' };

const server = new McpServer(SERVER_INFO);

/* ------------------------------------------------------------------ helpers */

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

/** Uniform error surface: every tool returns a readable message, never throws. */
async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DeepSeekError) {
      const hint =
        e.code === 40002 || e.code === 40003
          ? '\n\nThe web session token is missing or expired. Log into chat.deepseek.com in the ' +
            'bridge browser, then run `node tools/capture-token.mjs` to refresh it.'
          : '';
      return fail(`${e.message}${hint}`);
    }
    if (e?.name === 'AbortError') return fail('Request cancelled before the reply finished.');
    if (e?.code === 'ENOENT') return fail(`No such file: ${e.path ?? '(unknown path)'}`);
    return fail(`Unexpected error: ${e?.message ?? String(e)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The backend accepts about two requests in flight and silently answers with an
 * empty stream beyond that, so parallel work is capped and retried rather than
 * trusted.
 */
async function completeRetry(opts, { attempts = 3, label = 'request' } = {}) {
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

/** Map with a hard concurrency cap (order preserved). */
async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/** Upload whatever the caller handed us, once, and hand back the ids. */
async function attach(paths, authorization) {
  const single = typeof paths === 'string' ? [paths] : paths ?? [];
  if (!single.length) return [];
  return uploadFiles(single, { authorization });
}

const describeFiles = (files) =>
  files.map((f) => `  ${f.id}\n    ${f.name} — ${f.size} bytes, ${f.tokens} tokens, status ${f.status}`).join('\n');

/* --------------------------------------------------------------------- ask */

const askArgs = {
  prompt: z.string().min(1).describe('The message to send.'),
  files: z
    .array(z.string())
    .optional()
    .describe(
      'Local file paths to send as attachments (e.g. a .tex manuscript). ' +
        'Each is uploaded once and referenced by id — the contents are NOT inlined into the prompt.'
    ),
  thinking: z
    .boolean()
    .optional()
    .describe('Enable 深度思考 (chain-of-thought). Slower, better on hard analysis. Default false.'),
  search: z.boolean().optional().describe('Enable 联网搜索 (web search). Default false.'),
  chatSessionId: z.string().optional().describe('Continue an existing conversation.'),
  parentMessageId: z.number().int().optional().describe('Message id to reply under (for multi-turn).'),
  includeReasoning: z
    .boolean()
    .optional()
    .describe('Also return the 深度思考 reasoning text when thinking was enabled. Default false.'),
  timeoutMs: z.number().int().min(5000).max(1800000).optional().describe('Give up after this long.'),
};

async function runAsk({
  prompt,
  files,
  thinking = false,
  search = false,
  chatSessionId,
  parentMessageId,
  includeReasoning = false,
  timeoutMs = 600000,
}) {
  const authorization = await loadToken();
  const attached = await attach(files, authorization);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await complete({
      prompt,
      thinking,
      search,
      chatSessionId,
      parentMessageId: parentMessageId ?? null,
      refFileIds: attached.map((f) => f.id),
      signal: controller.signal,
    });

    const lines = [];
    if (attached.length) {
      lines.push(`Attached ${attached.length} file(s):`);
      lines.push(describeFiles(attached));
      lines.push('');
    }
    lines.push(r.text.trim() || '(empty reply)', '');
    lines.push('---');
    lines.push(
      `sessionId: ${r.sessionId}  messageId: ${r.messageId ?? '?'}  tokens: ${r.tokens}  ` +
        `pow: ${r.powMs}ms  total: ${r.elapsedMs}ms`
    );
    if (includeReasoning && r.reasoning) {
      lines.push('', '<reasoning>', r.reasoning.trim(), '</reasoning>');
    }
    return text(lines.join('\n'));
  } finally {
    clearTimeout(timer);
  }
}

server.tool(
  'ask',
  [
    'Send a prompt to DeepSeek through the web backend and return the reply.',
    'Uses the free web-session quota of the logged-in account — never the billed API.',
    'Pass `files` to attach documents by path: they are uploaded and referenced by id, not pasted inline.',
    'Omit chatSessionId to start a fresh conversation; pass it with parentMessageId to continue one.',
  ].join(' '),
  askArgs,
  async (a) => guard(() => runAsk(a))
);

/* ------------------------------------------------------------------- files */

server.tool(
  'upload_file',
  'Upload local files to DeepSeek and return their attachment ids. Use the ids with ask(fileIds).',
  {
    paths: z.array(z.string()).min(1).describe('Local file paths to upload.'),
    verbose: z.boolean().optional().describe('Also re-read each file’s parse status afterwards.'),
  },
  async ({ paths, verbose = false }) =>
    guard(async () => {
      const uploaded = await attach(paths, undefined);
      const lines = [`Uploaded ${uploaded.length} file(s):`, describeFiles(uploaded)];
      if (verbose) {
        const fresh = await fetchFiles(uploaded.map((f) => f.id));
        lines.push('', 'Parse status:');
        for (const f of fresh) lines.push(`  ${f.id} ${f.file_name}: ${f.status}`);
      }
      lines.push('', 'Keep the `file-` prefix when passing these back as refFileIds.');
      return text(lines.join('\n'));
    })
);

server.tool(
  'ask_with_files',
  'Attach files (by path OR by already-uploaded file id) and ask one question about them.',
  {
    prompt: z.string().min(1).describe('The question.'),
    paths: z.array(z.string()).optional().describe('Local paths to upload first.'),
    fileIds: z.array(z.string()).optional().describe('Ids already returned by upload_file.'),
    thinking: z.boolean().optional(),
    search: z.boolean().optional(),
    chatSessionId: z.string().optional(),
    timeoutMs: z.number().int().min(5000).max(1800000).optional(),
  },
  async ({ prompt, paths, fileIds, thinking = false, search = false, chatSessionId, timeoutMs = 600000 }) =>
    guard(async () => {
      const authorization = await loadToken();
      const uploaded = await attach(paths, authorization);
      const ids = [...uploaded.map((f) => f.id), ...(fileIds ?? [])];
      if (!ids.length) return fail('Nothing to attach: give `paths` or `fileIds`.');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const r = await complete({
          prompt,
          thinking,
          search,
          chatSessionId,
          refFileIds: ids,
          signal: controller.signal,
        });
        return text(
          [
            `attachments: ${ids.join(', ')}`,
            '',
            r.text.trim() || '(empty reply)',
            '',
            '---',
            `sessionId: ${r.sessionId}  tokens: ${r.tokens}  total: ${r.elapsedMs}ms`,
          ].join('\n')
        );
      } finally {
        clearTimeout(timer);
      }
    })
);

/* ----------------------------------------------------------- paper review */

const PERSONAS = [
  {
    id: 'theory',
    title: '理论严谨性 / 可辨识性',
    brief: `你是一位专攻系统辨识与可辨识性理论（structural / practical / sampled-data identifiability）的资深审稿人。
只从**理论严谨性**角度审阅：定义是否自洽、定理与证明是否成立、概念边界（结构非可辨识 vs 实际非可辨识 vs 第三类）是否真被分离、有无循环论证或隐含假设、"零"的判定是否可证伪。
不要评论写作风格、不要评论实验细节、不要提排版。`,
  },
  {
    id: 'experiment',
    title: '实验设计与统计',
    brief: `你是一位以实验严谨性著称的审稿人，熟悉电力电子与嵌入式测量。
只从**实验设计与统计**角度审阅：样本量/窗口数是否自洽、估计器比较是否公平、误差与不确定度是否量化、对照是否充分、可复现信息是否足够、数字在摘要/表/图/正文是否一致。
请具体列出你看到的矛盾数值。不要评论理论框架、不要提排版。`,
  },
  {
    id: 'argument',
    title: '论证链与主张-证据一致性',
    brief: `你是一位以"砍主张"闻名的严格编辑。
只审阅**论证链**：标题/摘要/引言承诺了什么，正文是否兑现；每处 claim 是否有对应证据；有无过度声称、有无把相关性说成因果、有无把"新命名"包装成"新发现"。
逐条列出"声称 → 是否有支撑 → 问题"。不要评论具体数值、不要提排版。`,
  },
  {
    id: 'journal',
    title: '期刊适配与贡献度',
    brief: `你是 IEEE Transactions on Industrial Electronics 的副编辑。
只评估**期刊适配性与贡献度**：相对已有文献的真正增量、是否够 TIE 门槛、读者会不会用、可推广性、还差什么才能达到接收标准。
给出明确判断（接收/小修/大修/拒稿）并说明理由。不要逐句挑错。`,
  },
  {
    id: 'adversary',
    title: '反方审稿人（红队）',
    brief: `你是最不友好的那位审稿人，任务是找出能让本文被拒的致命问题。
只做红队：最可能被攻击的弱点、最经不起追问的假设、最易被同行指出的漏洞。每条写成"如果我问 X，作者可能答不上来，因为 Y"。
不要给改进建议、不要说优点。`,
  },
  {
    id: 'reproduce',
    title: '可复现性与工程落地',
    brief: `你是负责复现性审查的审稿人，会照文章真的去做。
只审阅**可复现性**：照此文能否重建实验？缺哪些参数/宏定义/代码/数据？Reproduction 一节是否够？读者拿到仓库第一步会卡在哪？
列成清单。不要评论理论、不要提排版。`,
  },
];

server.tool(
  'paper_review',
  [
    'Run a LaTeX manuscript past several independent reviewers on the web backend and merge their verdicts.',
    'The file is uploaded ONCE and attached by id to every reviewer, so the manuscript is never pasted into a prompt.',
    'Each reviewer gets its own conversation; results are written to disk as they land.',
  ].join(' '),
  {
    texPath: z.string().describe('Path to the .tex (or .pdf) manuscript to review.'),
    outPath: z.string().optional().describe('Where to write the merged Markdown report.'),
    personas: z.number().int().min(1).max(6).optional().describe('How many reviewers to run. Default 5.'),
    thinking: z.boolean().optional().describe('Enable 深度思考 for each reviewer. Slower, deeper. Default false.'),
    concurrency: z.number().int().min(1).max(3).optional().describe('Parallel reviewers. The backend caps near 2.'),
  },
  async ({ texPath, outPath, personas = 5, thinking = false, concurrency = 2 }) =>
    guard(async () => {
      const authorization = await loadToken();
      const file = await uploadFile(texPath, { authorization });
      if (file.status !== 'SUCCESS') {
        return fail(`Upload did not finish parsing: status=${file.status} id=${file.id}`);
      }

      const chosen = PERSONAS.slice(0, personas);
      const report = outPath ?? join(dirname(resolve(texPath)), 'deepseek-review-report.md');
      const cacheDir = join(dirname(report), '.deepseek-review');
      await mkdir(cacheDir, { recursive: true });

      const results = [];
      await pMap(chosen, concurrency, async (persona, idx) => {
        const t0 = Date.now();
        const r = await completeRetry(
          {
            prompt: [
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
            ].join('\n'),
            thinking,
            search: false,
            refFileIds: [file.id],
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
          `# ${persona.title}\n\n_model: ${r.tokens} tokens, ${item.ms}ms, session ${r.sessionId}_` +
            `\n\n_scores: ${item.scores ? JSON.stringify(item.scores) : 'n/a'}_\n\n${item.text}\n`,
          'utf8'
        );
        return item;
      });

      const graders = results.filter((r) => r?.scores);
      const scorecard = graders.length ? aggregateScores(graders) : null;
      const dossier = results.filter(Boolean).map((r, i) => `### 评审 ${i + 1}：${r.title}\n\n${r.text}`).join('\n\n');

      const synth = await completeRetry(
        {
          prompt: [
            '你是负责汇总评审意见的主编。下面是多位独立审稿人对同一篇论文的意见（互相看不到对方）。',
            '论文附件同前，可作为核对依据。',
            '',
            ...(scorecard
              ? [
                  '各审稿人已按 8 个维度打过分（1–10），汇总如下（中位数、区间、分歧 σ）：',
                  ...scorecard.rows.map(
                    (r) =>
                      `- ${r.label}: 中位 ${r.median ?? '—'}（${r.min ?? '—'}–${r.max ?? '—'}，σ=${r.spread ?? '—'}，权重 ${r.weight}）`
                  ),
                  `加权总分（中位数合成）：${scorecard.total} / 10 → ${scorecard.verdict}`,
                  '',
                  '请在第 2 条之后额外用一节 **评分分歧解读**：哪些维度分歧大（σ≥2）、为什么会有这种分歧、作者应按哪一方处理。分歧不是噪声，是真正的争议点。',
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
          ].join('\n'),
          thinking,
          search: false,
          refFileIds: [file.id],
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
        `- 评审路数：${results.filter(Boolean).length} 位独立审稿人 + 1 次主编汇总`,
        `- 通道：DeepSeek 网页会话额度（未走按量计费 API）`,
        `- 深度思考：${thinking ? '开' : '关'}`,
        '',
        '---',
        '',
      ];
      if (scorecard) {
        lines.push(renderScorecard(scorecard, { heading: `## 一、评分卡（8 维度，满分 10）` }));
        lines.push(
          `\`${graders.length}/${results.filter(Boolean).length}\` 位审稿人给出了可解析的分数。` +
            '每位审稿人独立打分、互相看不到对方；头条分取**中位数**，区间与 σ 反映分歧。',
          '',
          '---',
          '',
          '## 二、主编汇总',
          ''
        );
      } else {
        lines.push('## 一、主编汇总', '');
      }
      lines.push(synth.text.trim(), '', '---', '');
      lines.push('## 各审稿人原始意见', '');
      for (const r of results.filter(Boolean)) {
        // The score fence is machine data, not prose — show it as a compact line.
        const body = r.text.replace(/```(?:score|json)?\s*\{[\s\S]*?\}\s*```/g, '').trim();
        const scoreLine = r.scores
          ? Object.entries(r.scores)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')
          : '未给出可解析的分数';
        lines.push(`### ${r.title}`, '');
        lines.push(`<sub>${r.tokens} tokens · ${(r.ms / 1000).toFixed(1)}s · session ${r.sessionId}</sub>`, '');
        lines.push(`<sub>评分：${scoreLine}</sub>`, '');
        lines.push(body, '');
      }
      lines.push('---', '');
      lines.push(
        '> 由 `deepseek-web-mcp` 的 paper_review 生成：文件上传一次、按 id 附给每位审稿人；各审稿人独立会话互不可见，主编再归并去重。'
      );
      lines.push(
        '> 评分维度：' + DIMENSIONS.map((d) => `${d.label}(${d.weight})`).join(' / ') + '，满分 10。'
      );

      await writeFile(report, lines.join('\n'), 'utf8');

      const scoreSummary = scorecard
        ? `${scorecard.total} / 10 → ${scorecard.verdict}`
        : '（本次未取得可解析的评分）';

      return text(
        [
          `Reviewed \`${basename(texPath)}\` with ${results.filter(Boolean).length} reviewers.`,
          `attachment: ${file.id} (${file.tokens} tokens)`,
          `report: ${report}`,
          '',
          `--- 加权总分：${scoreSummary} ---`,
          scorecard
            ? scorecard.rows
                .filter((r) => r.median != null)
                .map((r) => `  ${r.label}: ${r.median}（${r.min}–${r.max}）`)
                .join('\n')
            : '',
          '',
          '--- 主编汇总 ---',
          synth.text.trim(),
        ].join('\n')
      );
    })
);

/* -------------------------------------------------------------- housekeeping */

server.tool(
  'new_chat',
  'Create a fresh DeepSeek conversation and return its session id.',
  {},
  async () =>
    guard(async () => {
      const id = await createSession();
      return text(`New conversation created.\nchatSessionId: ${id}`);
    })
);

server.tool(
  'list_sessions',
  'List recent DeepSeek conversations with their ids and titles.',
  {
    count: z.number().int().min(1).max(100).optional().describe('How many to return. Default 20.'),
  },
  async ({ count = 20 }) =>
    guard(async () => {
      const sessions = await listSessions(undefined, { count });
      if (!sessions.length) return text('No conversations found.');
      const body = sessions.map((s, i) => `${i + 1}. ${s.title || '(untitled)'}\n   id: ${s.id}`).join('\n');
      return text(`${sessions.length} conversation(s):\n\n${body}`);
    })
);

server.tool(
  'status',
  'Check whether the stored web-session token still works, and report quota-free mode.',
  {},
  async () =>
    guard(async () => {
      const authorization = await loadToken();
      const res = await fetch(`${BASE}/api/v0/users/current`, {
        headers: { authorization, origin: BASE, referer: `${BASE}/` },
      });
      const json = await res.json().catch(() => null);
      if (json?.code !== 0) {
        return fail(
          `Token rejected: HTTP ${res.status} code=${json?.code} ${json?.msg ?? ''}\n` +
            `Refresh it by logging into chat.deepseek.com in the bridge browser, then run ` +
            `\`node tools/capture-token.mjs\`.`
        );
      }
      const u = json.data?.biz_data ?? {};
      return text(
        [
          'Signed in and ready.',
          `name: ${u.name ?? '(unset)'}`,
          `email: ${u.email ?? '(unset)'}`,
          `token file: ${tokenPath()}`,
          'billing: none — this uses the free web-session quota, not the billed API.',
        ].join('\n')
      );
    })
);

server.tool(
  'pow_selftest',
  'Run the proof-of-work solver against a live challenge and report how long it took. Useful after a site update.',
  {},
  async () =>
    guard(async () => {
      const authorization = await loadToken();
      const res = await fetch(`${BASE}/api/v0/chat/create_pow_challenge`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'x-client-bundle-id': 'com.deepseek.chat',
          'x-client-version': '2.7.0',
          'x-client-platform': 'web',
          origin: BASE,
          referer: `${BASE}/`,
        },
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
      });
      const json = await res.json();
      const challenge = json?.data?.biz_data?.challenge;
      if (!challenge) return fail(`Could not obtain a challenge: ${JSON.stringify(json).slice(0, 300)}`);
      const { answer, elapsedMs } = await solveChallenge(challenge);
      return text(
        `PoW solved.\nanswer: ${answer}\nalgorithm: ${challenge.algorithm}\n` +
          `difficulty: ${challenge.difficulty}\nsolve time: ${elapsedMs}ms`
      );
    })
);

/* ------------------------------------------------------------------- boot */

const transport = new StdioServerTransport();
await server.connect(transport);
