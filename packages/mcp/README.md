# @sol-wallet/mcp

An MCP server that lets an AI client (Claude Code, Cursor, Claude Desktop, …) drive a Solana test wallet: create and import wallets, send SOL / SPL / Token-2022 transfers, create and manage token mints and extensions, run Squads multisig flows, and decode transactions, including raw signed transactions that never landed.

Built for **testing on devnet, testnet or a local validator**. Wallets live only in the server's memory.

## Quick start

**Claude Code**

```bash
claude mcp add solwallet -e SOLWALLET_CLUSTER=devnet -- npx -y @sol-wallet/mcp
```

**Other clients (JSON config)**

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

Requires Node.js 20 or later.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `SOLWALLET_CLUSTER` | `devnet` | `devnet` / `testnet` / `mainnet-beta` or any RPC URL (Helius, QuickNode, `http://127.0.0.1:8899`, …). Every tool also takes a `cluster` argument. |

## What it can do

33 tools, grouped:

- **Wallets**: `create_wallet`, `import_wallet`, `list_wallets`, `export_secret`, `remove_wallet`
- **Cluster**: `get_cluster_status`, `request_airdrop`, `get_balances`
- **Transfers**: `transfer`, `batch_transfer`, `mixed_transfer`, `preflight_transfer`, `build_transfer`, `approve_delegate`, `revoke_delegate`, `cpi_token_transfer`
- **Raw transactions**: `sign_transaction`, `simulate_transaction`, `send_transaction`
- **Tokens**: `create_token` (SPL with Metaplex metadata, or Token-2022 with extensions), `manage_token2022` (21 runtime actions), `find_withheld_accounts`
- **Multisig (Squads v4)**: `create_multisig`, `propose_multisig`, `approve_multisig`, `execute_multisig`, `get_multisig`
- **Inspection**: `derive_address`, `inspect_mint`, `inspect_token_account`, `inspect_transaction`, `inspect_raw_transaction`
- **Guide**: `get_guide`

## Built-in usage guide

No Skill or extra setup needed. When a client connects, the server sends its key rules (amount units, error handling, red lines) as MCP instructions. The full manual (tool selection, preflight codes, error codes, playbooks and end-to-end recipes) is bundled in the package: the model reads a section with `get_guide({ topic })`, and clients that support resources can open `solwallet://guide` or `solwallet://guide/<topic>`.

All amounts are **base units** (lamports / token base units) as integer strings, with `*Display` hints next to them. Sending on `mainnet-beta` requires an explicit `allowMainnet: true`.

## Security

- Keys exist only in process memory and are gone on restart. Use `export_secret` (with an explicit confirmation flag) to back one up.
- Tool output is scrubbed so that loaded mnemonics and secret keys never appear in it, except through `export_secret`.

## More

The full manual, the companion Claude Skill and the web console are at [github.com/qinheqing/solana-wallet](https://github.com/qinheqing/solana-wallet).

## License

MIT
