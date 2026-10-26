/**
 * Transport adapter.
 *
 * The skill ships inside the `deepseek-web-api` repo but must also work if
 * someone copies just this directory. So the client is resolved at runtime
 * from, in order:
 *
 *   1. `DEEPSEEK_WEB_API_ROOT` — an explicit checkout to use
 *   2. `core/` next to this file — the vendored copy, the normal case
 *   3. this repo (three levels up) — developing against a live checkout
 *   4. `~/.dsh/deepseek-web/api` — an `npm i -g`-style install
 *
 * `core/` comes second so an explicit root can still override a stale vendored
 * copy during development. Failing loudly with every attempt listed beats a
 * stack trace about a missing relative module.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, '..');
const repoRoot = resolve(here, '..', '..', '..');

/** @returns {string[]} */
function candidates() {
  const out = [];
  if (process.env.DEEPSEEK_WEB_API_ROOT) out.push(resolve(process.env.DEEPSEEK_WEB_API_ROOT));
  out.push(join(skillRoot, 'core'));
  out.push(repoRoot);
  out.push(join(homedir(), '.dsh', 'deepseek-web', 'api'));
  return out;
}

/**
 * A candidate is usable if it holds `client.mjs` and `files.mjs`, either flat
 * (the vendored `core/` layout) or under `src/` (a repo checkout).
 *
 * @param {string} root
 * @returns {{client:string, files:string}|null}
 */
function layout(root) {
  const flat = { client: join(root, 'client.mjs'), files: join(root, 'files.mjs') };
  if (existsSync(flat.client) && existsSync(flat.files)) return flat;
  const nested = { client: join(root, 'src', 'client.mjs'), files: join(root, 'src', 'files.mjs') };
  if (existsSync(nested.client) && existsSync(nested.files)) return nested;
  return null;
}

let cached = null;

export async function loadApi() {
  if (cached) return cached;

  const tried = [];
  for (const root of candidates()) {
    const paths = layout(root);
    if (!paths) {
      tried.push(`${root} (no client.mjs + files.mjs)`);
      continue;
    }
    const client = await import(pathToFileURL(paths.client).href);
    const files = await import(pathToFileURL(paths.files).href);
    cached = { root, client, files };
    return cached;
  }

  throw new Error(
    'paper-review-deepseek: could not find the deepseek-web-api client.\n' +
      `Searched:\n${tried.map((t) => `  - ${t}`).join('\n')}\n` +
      'This directory should contain core/client.mjs. If it does not, the package\n' +
      'was copied without it; set DEEPSEEK_WEB_API_ROOT to a checkout that has it.'
  );
}

/** `complete()` with the token loaded automatically. */
export async function makeTransport({ log = () => {} } = {}) {
  const { client, files } = await loadApi();

  const authorization = await client.loadToken();
  log(`token ok (${client.tokenPath()})`);

  return {
    async complete({
      prompt,
      thinking = false,
      search = false,
      refFileIds = [],
      timeoutMs = 600_000,
      chatSessionId = null,
      parentMessageId = null,
    }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await client.complete({
          prompt,
          thinking,
          search,
          refFileIds,
          chatSessionId,
          parentMessageId,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
    async uploadFile(path) {
      return files.uploadFile(path, { authorization });
    },
    authorization,
  };
}
