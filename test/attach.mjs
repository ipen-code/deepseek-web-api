import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadToken, BASE, createSession } from '../src/client.mjs';
import { solveChallenge, powHeader } from '../src/pow.mjs';

const authorization = await loadToken();
const CLIENT = {
  authorization,
  origin: BASE,
  referer: BASE + '/',
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-version': '2.7.0',
  'x-client-platform': 'web',
  'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': '28800',
};

async function chall(target) {
  const r = await fetch(BASE + '/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: { ...CLIENT, 'content-type': 'application/json' },
    body: JSON.stringify({ target_path: target }),
  });
  const j = await r.json();
  const c = j.data.biz_data.challenge;
  const { answer } = await solveChallenge(c);
  return { c, answer };
}

const TEX = 'C:/Users/ipen/Desktop/PCM温控仿真/论文/V3.8/TIE_V3.8_main.tex';
const bytes = await readFile(TEX);

const upCh = await chall('/api/v0/file/upload_file');
const form = new FormData();
form.append('file', new Blob([bytes], { type: 'text/x-tex' }), basename(TEX));
const up = await (
  await fetch(BASE + '/api/v0/file/upload_file', {
    method: 'POST',
    headers: { ...CLIENT, 'x-ds-pow-response': powHeader(upCh.c, upCh.answer, '/api/v0/file/upload_file') },
    body: form,
  })
).json();
const fileId = up.data.biz_data.id;
console.log('uploaded', fileId, 'tokens', up.data.biz_data.token_usage);

const sid = await createSession(authorization);

const tryRef = async (refIds, label) => {
  const { c, answer } = await chall('/api/v0/chat/completion');
  const res = await fetch(BASE + '/api/v0/chat/completion', {
    method: 'POST',
    headers: {
      ...CLIENT,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-ds-pow-response': powHeader(c, answer, '/api/v0/chat/completion'),
    },
    body: JSON.stringify({
      chat_session_id: sid,
      parent_message_id: null,
      model_type: null,
      prompt: '附件是什么类型的文档？用一句话说明它的标题和主题。',
      ref_file_ids: refIds,
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false,
    }),
  });
  const t = await res.text();
  let text = '';
  for (const frame of t.split('\n\n')) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const e = JSON.parse(line.slice(5).trim());
        if (e.v && typeof e.v === 'object' && e.v.response) {
          text = (e.v.response.fragments ?? []).map((f) => f.content).join('');
        }
        if (e.p && e.p.endsWith('/content') && typeof e.v === 'string') text += e.v;
        if (typeof e.v === 'string' && !e.p) text += e.v;
      } catch {}
    }
  }
  console.log(`\n[${label}] HTTP ${res.status} -> ${JSON.stringify(text.slice(0, 400))}`);
};

await tryRef([fileId], 'with file- prefix');
await tryRef([fileId.replace(/^file-/, '')], 'without prefix');
