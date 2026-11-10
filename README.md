<div align="center">

# solana-wallet

**A Solana wallet testing toolkit — drive wallets, transfers, Token-2022 and multisig in plain language.**

One core library, four ways to use it: MCP server · Claude Skill · Web console · TypeScript library

**English** · [简体中文](./README.zh-CN.md)

![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-33_tools-7C3AED)
![Solana](https://img.shields.io/badge/Solana-devnet%20%7C%20testnet%20%7C%20localnet-9945FF?logo=solana&logoColor=white)

<img width="900" alt="Web console — dashboard" src="https://github.com/user-attachments/assets/e017b5b1-f9cb-4f28-a3ec-5a5c12d2532c" />

</div>

> [!WARNING]
> This is a **testing tool**, not a wallet for real funds. Keys live in process memory (MCP) or browser storage (Web). Every mainnet send needs an explicit opt-in.

## Why

Testing a Solana integration normally means juggling `solana-keygen`, `spl-token`, throwaway scripts and an explorer tab. Token-2022 extensions (transfer fees, hooks, memo-required, permanent delegate…) and multisig flows make that worse.

With solana-wallet you ask your AI client instead:

```txt
Create wallets alice and bob on devnet, then show alice's balances.
Create a Token-2022 mint with a 1% transfer fee, mint 1,000 tokens to alice, and send 100 to bob.
Preflight a transfer to an account that requires memos, then inspect why it failed.
Set up a 2-of-3 Squads multisig for alice, bob and carol and propose a 0.1 SOL payout.
```

## Highlights

- **Every token program** — SOL, SPL Token and Token-2022. The program is detected from the mint automatically.
- **Token-2022 first-class** — create mints with transfer fee, transfer hook, interest-bearing, non-transferable, permanent delegate, on-chain metadata, default account state and scaled UI amount extensions. Then manage them at runtime (15 actions).
- **Batch & mixed transfers** — send to 1–50 recipients in chunks, or put SOL plus several mints in one atomic transaction.
- **See before you send** — `build_transfer` returns the exact instructions, `preflight_transfer` flags hooks, memo, frozen, fee and allowance issues (block · warn · info), and `dryRun` simulates and returns full logs.
- **Explain what happened** — `inspect_transaction` decodes token movements (including CPI inner instructions), balance deltas and Token/Token-2022 error names.
- **Raw transaction lane** — partially sign, simulate and send hex/base64 transactions built elsewhere.
- **Multisig** — Squads V4 M-of-N: create → propose → approve → execute.
- **Safe by default** — secrets are redacted from all tool output, and mainnet sends require a literal `allowMainnet: true`.

## Quick start

Requirements: Node ≥ 20, pnpm ≥ 12.

```bash
git clone https://github.com/qinheqing/solana-wallet.git
cd solana-wallet
pnpm install && pnpm build
```

Then pick how you want to use it:

| I want to… | Go to |
|---|---|
| Talk to it from Claude Code / Cursor / any MCP client | [MCP server](#mcp-server) |
| Click through it in a browser | [Web console](#web-console) |
| Write test scripts in TypeScript | [Library](#library) |

> [!NOTE]
> The MCP server and the library are on npm as [`@sol-wallet/mcp`](https://www.npmjs.com/package/@sol-wallet/mcp) and [`@sol-wallet/core`](https://www.npmjs.com/package/@sol-wallet/core). The web console runs from a clone.

## MCP server

**Claude Code**

```bash
claude mcp add solwallet -- npx -y @sol-wallet/mcp
```

Restart Claude Code and try: *"Create a wallet called alice, check the devnet cluster status, then show her balances."*

<details>
<summary><b>Cursor / Claude Desktop / other clients (JSON config)</b></summary>

Add this to your client's MCP config (`.mcp.json`, `~/.cursor/mcp.json`, `claude_desktop_config.json`, …):

```json
{
  "mcpServers": {
    "solwallet": {
      "command": "npx",
      "args": ["-y", "@sol-wallet/mcp"],
      "env": { "SOLWALLET_CLUSTER": "devnet" }
    }
  }
}
```

</details>

<details>
<summary><b>Custom RPC (Helius / QuickNode) or a local validator</b></summary>

```bash
# Paid RPC endpoint
claude mcp add solwallet \
  -e SOLWALLET_CLUSTER="https://devnet.helius-rpc.com/?api-key=YOUR_KEY" \
  -- npx -y @sol-wallet/mcp

# Local solana-test-validator
claude mcp add solwallet \
  -e SOLWALLET_CLUSTER=http://127.0.0.1:8899 \
  -- npx -y @sol-wallet/mcp
```

</details>

**Usage guide, built in.** [`skills/solana-wallet/SKILL.md`](./skills/solana-wallet/SKILL.md) is the AI-facing manual: tool selection, the preflight code table, error handling, playbooks and end-to-end recipes. It ships inside `@sol-wallet/mcp`: the key rules are sent as server instructions when a client connects, and the model reads any section on demand with `get_guide` (also exposed as `solwallet://guide` resources). Nothing to install. Claude Code users can still copy the folder into `~/.claude/skills/` to have it as a Skill as well.

### Tools

37 tools in 11 groups. Every sending tool accepts `dryRun: true` (simulate only) and `cluster` (cluster name or RPC URL).

<details>
<summary><b>Wallets & cluster (8)</b></summary>

| Tool | What it does |
|---|---|
| `create_wallet` | Generate a BIP39 wallet (12 or 24 words), held in memory only. Refuses to replace an existing name unless `overwrite: true` |
| `import_wallet` | Import from keyfile JSON or a mnemonic (derivation path + passphrase supported) |
| `list_wallets` | Names, addresses and sources (never secrets) |
| `export_secret` | Export the mnemonic or keyfile JSON. Requires `dangerouslyAllowSecretExport: true` |
| `remove_wallet` | Forget a loaded wallet (`confirmName` must equal the name) |
| `get_cluster_status` | Slot, node version, approximate TPS |
| `request_airdrop` | Faucet request (refused on mainnet-beta) |
| `get_balances` | SOL plus every SPL / Token-2022 account |

</details>

<details>
<summary><b>Transfers (3) · Build & preflight (2)</b></summary>

| Tool | What it does |
|---|---|
| `transfer` | One SOL or token transfer. Runs preflight first (`force: true` to override). Supports compute budget, ATA mode, instruction variant, memo and delegate knobs |
| `batch_transfer` | 1–50 recipients, sent in sequential chunks |
| `mixed_transfer` | 2–10 legs (SOL + different mints) in one transaction with one signature |
| `build_transfer` | Build only: returns a `TransactionPlan` with every instruction, its accounts and data, size and signers |
| `preflight_transfer` | Read-only check: `{ ok, findings[] }` with `code` / `severity` / `message` |

</details>

<details>
<summary><b>Raw transactions (3) · Inspection (5)</b></summary>

| Tool | What it does |
|---|---|
| `sign_transaction` | Partially sign a hex/base64 transaction with loaded wallets |
| `simulate_transaction` | Simulate a serialized transaction and return logs / CU / error |
| `send_transaction` | Send a fully signed transaction with retry and confirmation |
| `derive_address` | Derive the ATA for owner × mint under both token programs (offline) |
| `inspect_mint` | Decimals, supply, authorities, every decoded Token-2022 extension and Metaplex metadata |
| `inspect_token_account` | Owner, amount, delegate, state and account-level extensions |
| `inspect_transaction` | Token and SOL movements (inner/CPI aware), balance changes and decoded errors, from a signature or offline JSON |
| `inspect_raw_transaction` | Decode a serialized transaction that may never have landed: verified signatures, accounts, decoded instructions, optional on-chain status |

</details>

<details>
<summary><b>Delegation (2) · CPI (1) · Tokens (3) · Multisig (5) · Guide (1)</b></summary>

| Tool | What it does |
|---|---|
| `approve_delegate` / `revoke_delegate` | Grant or revoke a delegate allowance on an ATA |
| `cpi_token_transfer` | Transfer through the bundled CPI forwarder program, so the movement shows up as an inner instruction |
| `create_token` | Create an SPL (optionally with Metaplex metadata) or Token-2022 mint from one of 7 presets or explicit extensions, optionally minting supply in the same call |
| `manage_token2022` | 21 runtime actions: mint, burn, set fee, freeze/thaw, change authorities, update metadata, scaled-UI multiplier, memo on/off, collect withheld fees, update hook program, pause/resume, close mint, interest rate, default account state, extension authorities |
| `find_withheld_accounts` | Token accounts of a transfer-fee mint that hold withheld fees |
| `create_multisig` | Create a Squads V4 M-of-N multisig and return its multisig and vault PDAs |
| `propose_multisig` / `approve_multisig` / `execute_multisig` | Propose, approve and execute a vault transfer |
| `get_multisig` | Members, threshold, vault and every proposal with its votes |
| `get_guide` | Read a section of the built-in usage guide (tool selection, preflight codes, errors, playbooks…) |

</details>

<details>
<summary><b>Accounts & lookup tables (4)</b></summary>

| Tool | What it does |
|---|---|
| `create_token_account` | Create a token account at a fresh, non-ATA address (sized for Token-2022 extensions); use it with `sourceTokenAccount` / `destinationTokenAccount` |
| `create_lookup_table` | Create an address lookup table, optionally seeded with addresses |
| `manage_lookup_table` | Extend, deactivate or close a lookup table |
| `inspect_lookup_table` | Authority, addresses, activity and slots of a lookup table; compile transfers against tables with `lookupTables` |

</details>

### Conventions

- **Amounts are base units, always.** Pass lamports or the token's smallest unit as integer strings: 1 SOL → `"1000000000"`, and 1.5 of a 6-decimal token → `"1500000"`. A value like `"1.5"` is rejected with `INVALID_INPUT`. Outputs are raw strings too, with a human-readable `*Display` hint such as `"1.5 SOL"`.
- **`decimals` is optional.** If you leave it out, it is read from the mint. It is only used for `transferChecked` and display, never for conversion.
- **Errors.** Failed calls return `isError: true` with `{ error: { code, message, suggestion } }`. Read `suggestion` first: it says what to fix. Input mistakes are always `INVALID_INPUT` and never reached the chain.
- **Every signed result** includes an `explorerUrl`. On-chain program errors add `error.custom = { code, name }`, for example `36 = NoMemo`.

## Web console

```bash
pnpm dev   # → http://localhost:5173
```

A local, single-page console built on the same core library. It switches between Chinese and English, and runs against devnet, testnet, mainnet-beta or a custom RPC.

| Page | What you can do |
|---|---|
| Dashboard | Cluster health, current wallet, SOL and every token account |
| Wallets | Create, import, export and delete wallets. Encrypt with a password, unlock several at once, derive ATAs |
| Transfer | Single, batch and mixed transfers, with a preview, preflight panel and dry run |
| Tokens | Create mints from presets. Mint, burn and manage Token-2022 extensions and Metaplex metadata |
| Multisig | Create or import Squads multisigs, then propose, approve and execute vault transfers |
| Inspector | Decode a transaction by signature or from pasted `getTransaction` JSON, and export the report |

<details>
<summary><b>More screenshots</b></summary>

| Wallets | Batch transfer |
|---|---|
| <img alt="Wallets" src="https://github.com/user-attachments/assets/32e1c233-fbc8-497e-9058-1ea3186e1554" /> | <img alt="Batch transfer" src="https://github.com/user-attachments/assets/6d90c5ec-9c38-4c06-ab4e-e8fdda087136" /> |
| **Tokens** | **Multisig** |
| <img alt="Tokens" src="https://github.com/user-attachments/assets/7a3072c6-2bdc-4588-96a6-214c14012e62" /> | <img alt="Multisig" src="https://github.com/user-attachments/assets/9482bbb2-e2a2-4b71-b794-16f4c4e9dce2" /> |

</details>

> [!CAUTION]
> Web wallets are saved in the browser's `localStorage`. If you set a password they are encrypted (AES-256-GCM + PBKDF2-SHA256); otherwise they are stored in plain text. Only use throwaway keys.

## Library

```ts
import { Keypair } from "@solana/web3.js";
import { createConnection, transfer, solToLamports, parseAmount } from "@sol-wallet/core";

const conn = createConnection("devnet"); // or a full RPC URL
const from = Keypair.fromSecretKey(/* 64-byte secret key */);

// SOL
await transfer(conn, { from, destination: "RECIPIENT", amount: solToLamports("0.5") });

// SPL or Token-2022: the program is detected, and the recipient ATA is derived
await transfer(conn, {
  from,
  destination: "RECIPIENT",
  mint: "MINT",
  amount: parseAmount("100", 6), // bigint base units
  decimals: 6,
});
```

`solToLamports` / `parseAmount` / `formatAmount` do exact string ↔ bigint conversion with no floating-point error. [`examples/`](./examples/README.md) has three end-to-end scripts covering a transfer-fee net amount, memo block and force, and a permanent-delegate transfer:

```bash
solana-test-validator --reset          # terminal 1
pnpm example examples/fee-mint-net-amount.ts   # terminal 2
```

## Getting test SOL

The public devnet/testnet RPC faucets currently return HTTP 410, so `request_airdrop` reports `FAUCET_UNAVAILABLE`. Use one of these instead:

1. **[faucet.solana.com](https://faucet.solana.com)** — sign in with GitHub and paste your address.
2. **A paid RPC** (Helius, QuickNode…). Their devnet endpoints usually keep the faucet. Set it as `SOLWALLET_CLUSTER` or pass it as `cluster`.
3. **`solana-test-validator`** — unlimited airdrops and fully offline, which makes it the best choice for CI.

## Security model

- **Memory-only keys (MCP).** Wallets live in the server process and vanish on restart. Use `export_secret` if you need to keep one.
- **Two-layer redaction.** Sensitive keys are replaced with `[REDACTED]`, and any string containing a loaded wallet's mnemonic or secret bytes is redacted before serialization.
- **One explicit escape hatch.** Secrets can only be exported with `export_secret` plus `dangerouslyAllowSecretExport: true`.
- **No silent overwrites.** Reusing a wallet name fails unless `overwrite: true` is passed.
- **Mainnet guard.** Sends on mainnet-beta, including custom RPCs identified as mainnet by their genesis hash, need a literal `allowMainnet: true`. Airdrops on mainnet are always refused.

## Architecture

```
packages/
  core/          @sol-wallet/core — connection, wallets, transfers, tokens, inspection, multisig (no UI deps)
  mcp/           @sol-wallet/mcp  — 37 MCP tools, a thin layer over core (stdio)
  cpi-program/   Example Pinocchio program: authority-gated vault + transferChecked forwarder
apps/web/        React + Vite console
skills/          Claude Skill (SKILL.md)
examples/        Core-only end-to-end scripts
```

`core` knows nothing about MCP, React or AI, so a fix in core reaches every interface at once. The connection layer only retries sends on network, 429 or 5xx errors. It never blindly retries program errors or an expired blockhash, and it treats "already processed" as success.

## Development

```bash
pnpm test        # unit + MCP e2e tests (offline, fake RPC)
pnpm typecheck   # whole repo including examples/
pnpm build       # tsc → packages/*/dist

node packages/mcp/smoke-client.mjs   # live smoke test (set SOLWALLET_CLUSTER for localnet)
```

| Env var | Default | Description |
|---|---|---|
| `SOLWALLET_CLUSTER` | `devnet` | `devnet` / `testnet` / `mainnet-beta` or any RPC URL |
| `SMOKE_MNEMONIC` | — | Fixed mnemonic for the smoke client |

## Roadmap

- [x] Publish `@sol-wallet/core` and `@sol-wallet/mcp` to npm (`npx @sol-wallet/mcp`)
- [ ] Continue polishing the Web console
