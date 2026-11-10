/**
 * The usage guide as an MCP tool (get_guide) and resources (solwallet://guide
 * and one per topic), so any client gets the manual with zero setup.
 */
import { GUIDE_TOPICS, guideSection, loadGuide, type GuideTopic } from "../guide.js";

const TOPIC_HELP: Record<GuideTopic, string> = {
  overview: "tool groups at a glance",
  "tool-selection": "user intent → which tool and key params",
  parameters: "shared parameters and transfer construction knobs (computeUnit*, ataMode, instruction, fee, memo, sourceOwner)",
  amounts: "the base-units rule with conversions",
  "preflight-codes": "every preflight finding code, its level and the fix",
  workflows: "step-by-step playbooks: wallet → airdrop → transfer, batch airdrop, mixed transfer, Token-2022 lifecycle, 2-of-3 multisig",
  examples: "end-to-end recipes: transfer-fee net amount, memo block and force, PermanentDelegate, offline fixtures, raw channel",
  errors: "error codes → what they mean and the right next action; retry policy",
  faucet: "devnet/testnet faucet status and alternatives",
  "red-lines": "things never to do without the user's explicit OK",
};

export function registerGuideTools(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  z: typeof import("zod").z,
): void {
  const topics = Object.keys(GUIDE_TOPICS) as [GuideTopic, ...GuideTopic[]];

  server.registerTool(
    "get_guide",
    {
      description:
        "Read the solwallet usage guide (markdown, Chinese). Call it BEFORE an unfamiliar or multi-step task, and when a tool returns an error code or preflight finding you don't know how to handle. Topics: " +
        topics.map((t) => `${t} — ${TOPIC_HELP[t]}`).join("; ") +
        ". topic \"all\" returns the whole guide (~40 KB); prefer a single topic.",
      inputSchema: {
        topic: z.enum([...topics, "all"] as [string, ...string[]]).describe("Guide section to return."),
      },
    },
    // Plain markdown, not the usual JSON envelope: the guide is meant to be read.
    async (args: { topic: string }) => {
      try {
        // The zod enum above already restricts topic to a GuideTopic or "all".
        const text = args.topic === "all" ? loadGuide() : guideSection(args.topic as GuideTopic);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "GUIDE_UNAVAILABLE", message: String(error instanceof Error ? error.message : error) } }) }],
        };
      }
    },
  );

  server.registerResource(
    "guide",
    "solwallet://guide",
    { title: "solwallet usage guide", description: "Full usage guide for the solwallet MCP tools.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: loadGuide() }] }),
  );
  for (const topic of topics) {
    server.registerResource(
      `guide-${topic}`,
      `solwallet://guide/${topic}`,
      { title: `solwallet guide: ${topic}`, description: TOPIC_HELP[topic], mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: guideSection(topic) }] }),
    );
  }
}
