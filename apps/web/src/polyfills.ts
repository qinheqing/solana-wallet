/**
 * Browser polyfills that MUST run before any other module is evaluated.
 *
 * ES imports are hoisted and evaluated in dependency order, so a Buffer
 * assignment placed after the imports in main.tsx runs too late:
 * @solana/spl-token-metadata (pulled in via @solwallet/core) calls
 * Buffer.from at module top level and throws ReferenceError on first paint.
 *
 * This module has no imports other than `buffer` and is imported as the very
 * first statement of main.tsx so it is evaluated before everything else.
 */
import { Buffer } from "buffer";

const g = globalThis as unknown as {
  Buffer?: typeof Buffer;
  process?: { env: Record<string, string | undefined>; nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => void };
};
if (!g.Buffer) g.Buffer = Buffer;

// @sqds/multisig bundles Node's `util`, which reads process.env.NODE_DEBUG at
// module top level. The production build inlines `process.env`, but Vite's dev
// pre-bundle does not, so dev mode threw "process is not defined" on first paint.
if (!g.process) {
  g.process = {
    env: {},
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  };
}

export {};
