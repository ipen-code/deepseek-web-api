/**
 * DeepSeekHashV1 proof-of-work solver.
 *
 * The web client solves this in a Web Worker. We run the very same
 * WebAssembly module (sha3_wasm_bg.wasm, shipped with the site) directly in
 * Node, so the hash implementation is byte-for-byte identical to the browser's
 * and we never have to reimplement their custom Keccak sponge by hand.
 *
 * The solve loop, recovered from chunk 76608.8f2a9fa413.js:
 *
 *   prefix = salt + "_" + expireAt + "_"
 *   for (i = 0; i < difficulty; i++)
 *     if (sha3_256(prefix + i) === challenge) return i
 *
 * i.e. the server picks answer < difficulty and publishes challenge =
 * sha3_256(`${salt}_${expireAt}_${answer}`). We brute-force the small space.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WASM_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'wasm', 'sha3_wasm_bg.wasm');

let enginePromise = null;

/** Overridable so callers can refresh the wasm from the live site. */
export function setWasmPath(p) {
  enginePromise = null;
  wasmPathOverride = p;
}
let wasmPathOverride = null;

async function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const bytes = await readFile(wasmPathOverride ?? WASM_PATH);
      const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
      const ex = instance.exports;
      const encoder = new TextEncoder();

      // Write a JS string into wasm linear memory using its own allocator.
      const put = (s) => {
        const b = encoder.encode(s);
        const ptr = ex.__wbindgen_export_0(b.length, 1) >>> 0;
        new Uint8Array(ex.memory.buffer).subarray(ptr, ptr + b.length).set(b);
        return [ptr, b.length];
      };

      /** @returns {number} the answer, or -1 when no solution exists */
      const solve = (challenge, prefix, difficulty) => {
        const [cp, cl] = put(challenge);
        const [pp, pl] = put(prefix);
        const ret = ex.__wbindgen_add_to_stack_pointer(-16);
        try {
          ex.wasm_solve(ret, cp, cl, pp, pl, difficulty);
          const dv = new DataView(ex.memory.buffer);
          const solved = dv.getInt32(ret + 0, true);
          const answer = dv.getFloat64(ret + 8, true);
          return solved === 0 ? -1 : answer;
        } finally {
          ex.__wbindgen_add_to_stack_pointer(16);
        }
      };
      return { solve };
    })();
  }
  return enginePromise;
}

/**
 * Solve a challenge as returned by POST /api/v0/chat/create_pow_challenge.
 * @param {{challenge:string,salt:string,difficulty:number,expire_at?:number,expireAt?:number,signature:string}} challenge
 * @returns {Promise<{answer:number, elapsedMs:number}>}
 */
export async function solveChallenge(challenge) {
  const expireAt = challenge.expire_at ?? challenge.expireAt;
  if (expireAt == null) throw new Error('pow: challenge is missing expire_at');
  const { solve } = await engine();

  const prefix = `${challenge.salt}_${expireAt}_`;
  const started = Date.now();
  const answer = solve(challenge.challenge, prefix, challenge.difficulty);

  if (answer < 0 || !Number.isInteger(answer)) {
    throw new Error(
      `pow: no answer in [0,${challenge.difficulty}) for challenge=${challenge.challenge} prefix=${prefix}`
    );
  }
  return { answer, elapsedMs: Date.now() - started };
}

/**
 * Build the `x-ds-pow-response` header value. Base64 of the canonical JSON
 * object the web client sends — field order matters only cosmetically, the
 * server parses it as JSON.
 */
export function powHeader(challenge, answer, targetPath) {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
