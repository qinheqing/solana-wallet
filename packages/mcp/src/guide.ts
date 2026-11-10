/**
 * The usage guide (skills/solana-wallet/SKILL.md) served from inside the MCP
 * server, so clients get the full manual without installing a Claude Skill.
 *
 * Single source of truth: the build copies SKILL.md to dist/guide/SKILL.md
 * (see scripts/copy-guide.mjs); in the monorepo (tests, `tsx`) the file is
 * read straight from skills/.
 */
import { readFileSync } from "node:fs";

const CANDIDATES = [
  // published package: dist/guide.js → dist/guide/SKILL.md
  new URL("./guide/SKILL.md", import.meta.url),
  // monorepo source: packages/mcp/src/guide.ts → skills/solana-wallet/SKILL.md
  new URL("../../../skills/solana-wallet/SKILL.md", import.meta.url),
];

/** Topic id → heading prefix of the `## ` section it maps to. */
export const GUIDE_TOPICS = {
  overview: "能力总览",
  "tool-selection": "工具决策表",
  parameters: "参数约定",
  amounts: "金额单位",
  "preflight-codes": "预检代码参考",
  workflows: "工作流剧本",
  examples: "组合示例",
  errors: "错误处理",
  faucet: "水龙头",
  "red-lines": "红线",
} as const;

export type GuideTopic = keyof typeof GUIDE_TOPICS;

let cached: string | null = null;

/** Full guide markdown without the YAML front matter. */
export function loadGuide(): string {
  if (cached !== null) return cached;
  for (const url of CANDIDATES) {
    try {
      const raw = readFileSync(url, "utf8");
      cached = raw.replace(/^---\n[\s\S]*?\n---\n+/, "");
      return cached;
    } catch {
      /* try the next location */
    }
  }
  throw new Error("Usage guide not found (expected dist/guide/SKILL.md). Rebuild @sol-wallet/mcp.");
}

/** One `## ` section (with its `### ` subsections) by topic id. */
export function guideSection(topic: GuideTopic): string {
  const prefix = GUIDE_TOPICS[topic];
  const sections = loadGuide().split(/^(?=## )/m);
  const hit = sections.find((s) => s.startsWith(`## ${prefix}`));
  if (!hit) throw new Error(`Guide section "${topic}" (## ${prefix}…) is missing from SKILL.md.`);
  return hit.trimEnd();
}
