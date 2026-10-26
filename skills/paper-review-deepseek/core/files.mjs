/**
 * File transfer: push a document as a real attachment instead of inlining it
 * into the prompt.
 *
 * Why bother — pasting a 70 KB .tex into the prompt works, but the model sees
 * it as chat text: no filename, no attachment semantics, and every turn re-pays
 * the tokens. Uploading gives a stable `file-<uuid>` id the backend parses once
 * and reuses, which is also what the web UI itself does.
 *
 * Two endpoints, both proof-of-work gated:
 *   POST /api/v0/file/upload_file   multipart `file`
 *   GET  /api/v0/file/fetch_files?file_ids=a,b
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { BASE, loadToken, DeepSeekError } from './client.mjs';
import { solveChallenge, powHeader } from './pow.mjs';

const TARGET_UPLOAD = '/api/v0/file/upload_file';

const MIME = {
  '.tex': 'text/x-tex',
  '.latex': 'text/x-tex',
  '.bib': 'text/x-bibtex',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function clientHeaders(authorization) {
  return {
    authorization,
    origin: BASE,
    referer: `${BASE}/`,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-version': '2.7.0',
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
}

/** Ask for a challenge scoped to the upload endpoint and solve it. */
async function uploadPow(authorization) {
  const res = await fetch(`${BASE}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: { ...clientHeaders(authorization), 'content-type': 'application/json' },
    body: JSON.stringify({ target_path: TARGET_UPLOAD }),
  });
  const json = await res.json();
  const biz = json?.data;
  if (json.code !== 0 || biz?.biz_code !== 0) {
    throw new DeepSeekError(
      `upload challenge failed: code=${json?.code} biz_code=${biz?.biz_code} ${biz?.biz_msg ?? ''}`,
      { code: json?.code, bizCode: biz?.biz_code }
    );
  }
  const challenge = biz.biz_data.challenge;
  const { answer, elapsedMs } = await solveChallenge(challenge);
  return { challenge, answer, powMs: elapsedMs };
}

/**
 * Upload one local file.
 *
 * @returns {Promise<{id:string, name:string, size:number, tokens:number, status:string, isImage:boolean}>}
 *   `id` carries the `file-` prefix — keep it, that is what `ref_file_ids` wants.
 */
export async function uploadFile(path, { authorization, signal } = {}) {
  const auth = authorization ?? (await loadToken());
  const info = await stat(path);
  if (!info.isFile()) throw new DeepSeekError(`Not a file: ${path}`);
  const bytes = await readFile(path);
  const name = basename(path);
  const mime = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

  const { challenge, answer, powMs } = await uploadPow(auth);

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), name);

  const res = await fetch(`${BASE}${TARGET_UPLOAD}`, {
    method: 'POST',
    headers: { ...clientHeaders(auth), 'x-ds-pow-response': powHeader(challenge, answer, TARGET_UPLOAD) },
    body: form,
    signal,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DeepSeekError(`upload_file: HTTP ${res.status}, non-JSON: ${text.slice(0, 300)}`, {
      status: res.status,
      body: text,
    });
  }
  if (json.code !== 0) {
    throw new DeepSeekError(`upload_file: code=${json.code} msg=${json.msg}`, {
      status: res.status,
      code: json.code,
      body: text,
    });
  }
  const biz = json.data;
  if (biz.biz_code !== 0) {
    throw new DeepSeekError(`upload_file: biz_code=${biz.biz_code} biz_msg=${biz.biz_msg}`, {
      bizCode: biz.biz_code,
      body: text,
    });
  }

  const f = biz.biz_data;
  return {
    id: f.id,
    name: f.file_name,
    size: f.file_size,
    tokens: f.token_usage ?? 0,
    status: f.status,
    isImage: !!f.is_image,
    powMs,
  };
}

/** Re-read parse status for a set of ids (the UI polls this after uploading). */
export async function fetchFiles(fileIds, { authorization } = {}) {
  const auth = authorization ?? (await loadToken());
  const q = fileIds.join(',');
  const res = await fetch(`${BASE}/api/v0/file/fetch_files?file_ids=${encodeURIComponent(q)}`, {
    headers: clientHeaders(auth),
  });
  const json = await res.json();
  if (json.code !== 0) throw new DeepSeekError(`fetch_files: code=${json.code} msg=${json.msg}`, { code: json.code });
  return json.data?.biz_data?.files ?? [];
}

/** Upload several files with a cap on how many run at once. */
export async function uploadFiles(paths, { authorization, signal, concurrency = 2 } = {}) {
  const out = new Array(paths.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= paths.length) return;
        out[i] = await uploadFile(paths[i], { authorization, signal });
      }
    })
  );
  return out;
}
