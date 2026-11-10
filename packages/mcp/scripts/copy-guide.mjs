// Bundle the usage guide into the package: skills/solana-wallet/SKILL.md → dist/guide/SKILL.md.
// SKILL.md in the repo stays the single source of truth (see src/guide.ts).
import { copyFileSync, mkdirSync } from "node:fs";

const src = new URL("../../../skills/solana-wallet/SKILL.md", import.meta.url);
const dir = new URL("../dist/guide/", import.meta.url);
mkdirSync(dir, { recursive: true });
copyFileSync(src, new URL("SKILL.md", dir));
