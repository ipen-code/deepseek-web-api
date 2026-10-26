/**
 * Minimal client for the chat.deepseek.com web backend.
 *
 * Everything here speaks the same private API the browser app uses, with the
 * user's own web session token. No API key, no billing, no browser.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { solveChallenge, powHeader } from './pow.mjs';

export const BASE = 'https://chat.deepseek.com';

/** Client fingerprint headers the backend validates. Bump if the site does. */
const CLIENT = {
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-version': '2.7.0',
  'x-client-platform': 'web',
  'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

export class DeepSeekError extends Error {
  constructor(message, { status, code, bizCode, body } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.code = code;
    this.bizCode = bizCode;
    this.body = body;
  }
}

const DEFAULT_HEADERS = {
  ...CLIENT,
  'content-type': 'application/json',
  origin: BASE,
  referer: `${BASE}/`,
  'user-agent': UA,
};

/* ------------------------------------------------------------------ tokens */

export function tokenPath() {
  return process.env.DS_WEB_TOKEN_FILE || join(homedir(), '.dsh', 'deepseek-web', 'token.json');
}

/**
 * Read the stored web token. Shape: { authorization: "Bearer ...", savedAt }
 * A bare token via DS_WEB_TOKEN is also accepted.
 */
export async function loadToken() {
  const fromEnv = process.env.DS_WEB_TOKEN;
  if (fromEnv) return fromEnv.startsWith('Bearer ') ? fromEnv : `Bearer ${fromEnv}`;
  try {
    const parsed = JSON.parse(await readFile(tokenPath(), 'utf8'));
    if (parsed?.authorization) return parsed.authorization;
  } catch {
    /* fall through to the explicit error below */
  }
  throw new DeepSeekError(
    `No web token configured. Run \`node tools/capture-token.mjs\` once (needs the logged-in bridge browser), ` +
      `or set DS_WEB_TOKEN. Looked in ${tokenPath()}.`
  );
}

export async function saveToken(authorization) {
  const p = tokenPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ authorization, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  return p;
}

/* --------------------------------------------------------------- transport */

async function postJson(path, body, { authorization, signal, extraHeaders } = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, ...(authorization ? { authorization } : {}), ...extraHeaders },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DeepSeekError(`${path}: HTTP ${res.status}, non-JSON: ${text.slice(0, 300)}`, {
      status: res.status,
      body: text,
    });
  }
  if (json.code !== 0) {
    throw new DeepSeekError(`${path}: code=${json.code} msg=${json.msg || '(none)'}`, {
      status: res.status,
      code: json.code,
      body: text,
    });
  }
  return json;
}

/* --------------------------------------------------------------------- PoW */

async function challengeFor(targetPath, authorization) {
  const json = await postJson('/api/v0/chat/create_pow_challenge', { target_path: targetPath }, { authorization });
  const biz = json.data;
  if (biz.biz_code !== 0) {
    throw new DeepSeekError(`create_pow_challenge: biz_code=${biz.biz_code} biz_msg=${biz.biz_msg}`, {
      bizCode: biz.biz_code,
    });
  }
  return biz.biz_data.challenge;
}

/* ----------------------------------------------------------------- session */

export async function createSession(authorization) {
  const auth = authorization ?? (await loadToken());
  const json = await postJson('/api/v0/chat_session/create', {}, { authorization: auth });
  const id = json.data?.biz_data?.chat_session?.id ?? json.data?.biz_data?.id;
  if (!id) throw new DeepSeekError(`create_session: unexpected payload ${JSON.stringify(json).slice(0, 300)}`);
  return id;
}

async function getJson(path, { authorization, signal, extraHeaders } = {}) {
  const res = await fetch(BASE + path, {
    method: 'GET',
    headers: { ...DEFAULT_HEADERS, ...(authorization ? { authorization } : {}), ...extraHeaders },
    signal,
  });
  const t = await res.text();
  let json;
  try {
    json = JSON.parse(t);
  } catch {
    throw new DeepSeekError(`${path}: HTTP ${res.status}, non-JSON: ${t.slice(0, 300)}`, {
      status: res.status,
      body: t,
    });
  }
  if (json.code !== 0) {
    throw new DeepSeekError(`${path}: code=${json.code} msg=${json.msg || '(none)'}`, {
      status: res.status,
      code: json.code,
      body: t,
    });
  }
  return json;
}

export async function listSessions(authorization, { count = 20 } = {}) {
  const auth = authorization ?? (await loadToken());
  // NOTE: fetch_page is GET-only; POST returns HTTP 405.
  const json = await getJson(`/api/v0/chat_session/fetch_page?count=${count}`, { authorization: auth });
  return json.data?.biz_data?.chat_sessions ?? [];
}

/* -------------------------------------------------------------- completion */

/**
 * Incremental reducer for the completion event stream.
 *
 * Frame shapes seen from the live backend:
 *   {"v":{"response":{... full snapshot ...}}}
 *   {"v":"<text>"}                                   append to RESPONSE fragment
 *   {"p":"response/fragments/-1/content","o":"APPEND","v":"<text>"}
 *   {"p":"response/status","o":"SET","v":"FINISHED"}  terminal
 *   event: ready / update_session / title / close
 */
function makeReducer(onDelta) {
  const state = {
    text: '',
    reasoning: '',
    fragments: [], // [{ id, type: 'RESPONSE' | 'THINK', content }]
    messageId: null,
    requestId: null,
    status: null,
    modelType: null,
    tokens: 0,
  };

  /**
   * Recompute text/reasoning from the fragment list and emit whatever the
   * RESPONSE channel gained since the last call. The backend may address a
   * fragment as `-1` meaning "the last one added", which is why we cannot just
   * trust the index it sends — we mirror the list and resolve against it.
   */
  const recompute = () => {
    const text = state.fragments
      .filter((f) => f.type === 'RESPONSE')
      .map((f) => f.content)
      .join('');
    const think = state.fragments
      .filter((f) => f.type === 'THINK')
      .map((f) => f.content)
      .join('');
    state.reasoning = think;
    if (text !== state.text) {
      // Only ever append; if the server rewrote history, resync silently.
      if (text.startsWith(state.text)) onDelta?.(text.slice(state.text.length), text);
      state.text = text;
    }
  };

  const upsertFragment = (frag) => {
    const existing = state.fragments.find((f) => f.id === frag.id);
    if (existing) {
      if (frag.content != null) existing.content = frag.content;
      if (frag.type) existing.type = frag.type;
    } else {
      state.fragments.push({ id: frag.id, type: frag.type, content: frag.content ?? '' });
    }
  };

  const resolveIndex = (raw) => {
    const n = Number(raw);
    if (Number.isNaN(n)) return -1;
    return n === -1 ? state.fragments.length - 1 : state.fragments.findIndex((f) => f.id === n);
  };

  const applySnapshot = (r) => {
    if (typeof r.message_id === 'number') state.messageId = r.message_id;
    if (typeof r.status === 'string') state.status = r.status;
    if (typeof r.accumulated_token_usage === 'number') state.tokens = r.accumulated_token_usage;
    if (Array.isArray(r.fragments)) {
      state.fragments = r.fragments.map((f) => ({ id: f.id, type: f.type, content: f.content ?? '' }));
    }
    recompute();
  };

  const handle = (evt) => {
    if (evt == null) return;

    // Full response snapshot.
    if (evt.v && typeof evt.v === 'object' && !Array.isArray(evt.v) && evt.v.response) {
      applySnapshot(evt.v.response);
      return;
    }

    // Batched patch list.
    if (evt.o === 'BATCH' && Array.isArray(evt.v)) {
      for (const p of evt.v) handle(p);
      return;
    }

    // Property patch form. Parts look like `response/fragments/-1/content`.
    if (typeof evt.p === 'string') {
      const parts = evt.p.split('/');

      if (parts[parts.length - 1] === 'content' && parts.includes('fragments')) {
        const idx = resolveIndex(parts[parts.length - 2]);
        const frag = state.fragments[idx];
        if (frag) {
          if (evt.o === 'SET') frag.content = evt.v ?? '';
          else frag.content += evt.v ?? '';
          recompute();
        }
        return;
      }

      if (parts[parts.length - 1] === 'fragments' && evt.o === 'APPEND' && Array.isArray(evt.v)) {
        for (const f of evt.v) upsertFragment(f);
        recompute();
        return;
      }

      if (parts[parts.length - 1] === 'status') {
        state.status = evt.v;
        return;
      }
      if (parts[parts.length - 1] === 'accumulated_token_usage') {
        state.tokens = evt.v;
        return;
      }
      return;
    }

    // Bare token delta — always targets the newest fragment.
    if (typeof evt.v === 'string' && state.fragments.length) {
      state.fragments[state.fragments.length - 1].content += evt.v;
      recompute();
      return;
    }
    if (typeof evt.v === 'string' || typeof evt.v === 'number' || typeof evt.v === 'boolean') return;

    // Meta frames.
    if (typeof evt.request_message_id === 'number') state.requestId = evt.request_message_id;
    if (typeof evt.response_message_id === 'number') state.messageId = evt.response_message_id;
    if (evt.model_type) state.modelType = evt.model_type;
  };

  return { state, handle };
}

/**
 * Send one prompt and stream the answer back.
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} [o.chatSessionId]  omit to start a new conversation
 * @param {number|null} [o.parentMessageId]
 * @param {boolean} [o.thinking]      enable 深度思考
 * @param {boolean} [o.search]        enable 联网搜索
 * @param {string[]} [o.refFileIds]   attachment ids from `uploadFile()`; these
 *   must keep their `file-` prefix or the backend answers 422
 * @param {(delta:string, full:string)=>void} [o.onDelta]
 * @param {(delta:string)=>void} [o.onReasoning]
 * @param {AbortSignal} [o.signal]
 */
export async function complete(o) {
  const {
    prompt,
    parentMessageId = null,
    thinking = false,
    search = false,
    onDelta,
    onReasoning,
    signal,
    modelType = null,
    refFileIds = [],
  } = o;

  const authorization = o.authorization ?? (await loadToken());
  const started = Date.now();

  const chatSessionId = o.chatSessionId ?? (await createSession(authorization));
  const target = '/api/v0/chat/completion';

  const challenge = await challengeFor(target, authorization);
  const { answer, elapsedMs: powMs } = await solveChallenge(challenge);

  const res = await fetch(BASE + target, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      authorization,
      accept: 'text/event-stream',
      'x-ds-pow-response': powHeader(challenge, answer, target),
    },
    body: JSON.stringify({
      chat_session_id: chatSessionId,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt,
      ref_file_ids: refFileIds,
      thinking_enabled: thinking,
      search_enabled: search,
      action: null,
      preempt: false,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new DeepSeekError(`chat/completion: HTTP ${res.status} ${body.slice(0, 400)}`, {
      status: res.status,
      body,
    });
  }

  let reasoningSoFar = '';
  const { state, handle } = makeReducer((delta, full) => onDelta?.(delta, full));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const drainFrames = () => {
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          handle(JSON.parse(raw));
        } catch {
          /* ignore malformed frame */
        }
      }
      if (onReasoning && state.reasoning.length > reasoningSoFar.length) {
        onReasoning(state.reasoning.slice(reasoningSoFar.length));
        reasoningSoFar = state.reasoning;
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drainFrames();
  }

  return {
    text: state.text,
    reasoning: state.reasoning,
    sessionId: chatSessionId,
    messageId: state.messageId,
    status: state.status,
    tokens: state.tokens,
    powMs,
    elapsedMs: Date.now() - started,
  };
}
