#!/usr/bin/env node
/**
 * One-time token capture.
 *
 * The web app keeps the session bearer token in localStorage["userToken"] as a
 * JSON blob (`json:value,__version`). We attach to the already-running bridge
 * Chrome over the DevTools port — no login form, no QR, nothing to reopen — and
 * copy that value out into ~/.dsh/deepseek-web/token.json.
 *
 * After this runs once, nothing needs a browser anymore: src/client.mjs talks to
 * the backend directly and the token stays valid until the site logs you out.
 *
 * Usage:
 *   node tools/capture-token.mjs
 *   node tools/capture-token.mjs --port 9333
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { saveToken, tokenPath } from '../src/client.mjs';

const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i !== -1 ? Number(process.argv[i + 1]) : Number(process.env.DS_WEBCHAT_PORT || 9333);
})();

function loadPuppeteer() {
  const candidates = [
    'C:/Users/ipen/.dsh/profiles/desktop/package.json',
    `${process.env.USERPROFILE}/.dsh/profiles/desktop/package.json`,
  ].filter(Boolean);
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      return createRequire(c)('puppeteer-core');
    } catch {
      /* try next */
    }
  }
  try {
    return createRequire(import.meta.url)('puppeteer-core');
  } catch {
    return null;
  }
}

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    throw new Error('puppeteer-core not found. Install it: npm i puppeteer-core');
  }
  if (!(await portAlive(argPort))) {
    throw new Error(
      `No Chrome debugging port on ${argPort}. Start the bridge browser once ` +
        `(ds_webchat_open) or launch Chrome with --remote-debugging-port=${argPort}.`
    );
  }

  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${argPort}`, defaultViewport: null });
  try {
    const pages = await browser.pages();
    const page = pages.find((p) => p.url().includes('chat.deepseek.com'));
    if (!page) {
      throw new Error('No chat.deepseek.com tab found. Open it in the bridge browser and log in, then retry.');
    }

    const raw = await page.evaluate(() => {
      const v = localStorage.getItem('userToken');
      return v;
    });
    if (!raw) {
      throw new Error(
        'localStorage["userToken"] is empty — you are not logged in in this browser profile. Log in once, then retry.'
      );
    }

    // The stored value has taken at least two shapes across site versions:
    //   {"value":"<token>"}            <- current
    //   json:{"value":"<token>"},__version
    //   "<token>"
    // Handle all three, and also a bare {"value":{"value":"..."}} nest.
    const unwrap = (v, depth = 0) => {
      if (depth > 4 || v == null) return null;
      if (typeof v === 'string') {
        const t = v.trim();
        // A string that itself looks like JSON gets one more pass.
        if (t.startsWith('{') || t.startsWith('json:')) return unwrap(t, depth + 1);
        return t;
      }
      if (typeof v === 'object') {
        for (const k of ['value', 'token', 'userToken', 'access_token']) {
          if (k in v) {
            const r = unwrap(v[k], depth + 1);
            if (r) return r;
          }
        }
      }
      return null;
    };

    let parsed = raw;
    const m = /^json:(.*),__version$/s.exec(raw);
    if (m) parsed = m[1];
    try {
      parsed = JSON.parse(parsed);
    } catch {
      /* leave as the raw string */
    }

    const token = unwrap(parsed);
    if (typeof token !== 'string' || token.length < 20) {
      throw new Error(`Could not extract a token string (got ${typeof token} len=${String(token).length})`);
    }

    const authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    const saved = await saveToken(authorization);
    console.log(`token captured  len=${token.length}  -> ${saved}`);
    console.log(`(also ${tokenPath() === saved ? 'default' : 'custom'} path)`);

    // Sanity check: does the backend accept it?
    const who = await fetch('https://chat.deepseek.com/api/v0/users/current', {
      headers: {
        authorization,
        accept: '*/*',
        origin: 'https://chat.deepseek.com',
        referer: 'https://chat.deepseek.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0.0.0 Safari/537.36',
      },
    });
    const body = await who.json().catch(() => null);
    console.log(`verify /users/current -> HTTP ${who.status} code=${body?.code} ${body?.msg ?? ''}`);
    if (body?.code !== 0) {
      throw new Error(`token rejected by /users/current (code=${body?.code}). Log in again and recapture.`);
    }
  } finally {
    // Never kill the bridge browser — just detach.
    await browser.disconnect();
  }
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
