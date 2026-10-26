import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadToken, BASE } from '../src/client.mjs';
import { solveChallenge, powHeader } from '../src/pow.mjs';

const authorization = await loadToken();
const CLIENT = {
  authorization,
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-version': '2.7.0',
  'x-client-platform': 'web',
  'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': '28800',
  origin: BASE,
  referer: BASE + '/',
};

const TEX = 'C:/Users/ipen/Desktop/PCM温控仿真/论文/V3.8/TIE_V3.8_main.tex';
const bytes = await readFile(TEX);
console.log(`file ${basename(TEX)} ${bytes.length} bytes`);

// 1) challenge for the upload scene
const chRes = await fetch(BASE + '/api/v0/chat/create_pow_challenge', {
  method: 'POST',
  headers: { ...CLIENT, 'content-type': 'application/json' },
  body: JSON.stringify({ target_path: '/api/v0/file/upload_file' }),
});
const chJson = await chRes.json();
console.log('challenge:', chRes.status, JSON.stringify(chJson).slice(0, 300));
if (chJson.code !== 0) process.exit(1);
const challenge = chJson.data.biz_data.challenge;
const { answer, elapsedMs } = await solveChallenge(challenge);
console.log(`pow solved answer=${answer} ${elapsedMs}ms`);

// 2) upload as multipart
const form = new FormData();
form.append('file', new Blob([bytes], { type: 'text/x-tex' }), basename(TEX));
const up = await fetch(BASE + '/api/v0/file/upload_file', {
  method: 'POST',
  headers: { ...CLIENT, 'x-ds-pow-response': powHeader(challenge, answer, '/api/v0/file/upload_file') },
  body: form,
});
const upText = await up.text();
console.log('upload:', up.status, upText.slice(0, 800));
