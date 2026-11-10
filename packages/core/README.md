# @sol-wallet/core

TypeScript library behind [`@sol-wallet/mcp`](https://www.npmjs.com/package/@sol-wallet/mcp) and the solana-wallet web console: connections, wallets (keyfile / BIP39), SOL / SPL / Token-2022 transfers with preflight checks, token creation and extension management, Squads v4 multisig, and transaction inspection. No UI dependencies.

```bash
npm install @sol-wallet/core @solana/web3.js
```

```ts
import { Keypair } from "@solana/web3.js";
import { createConnection, transfer, solToLamports, parseAmount } from "@sol-wallet/core";

const conn = createConnection("devnet"); // or a full RPC URL
const from = Keypair.fromSecretKey(/* 64-byte secret key */);

// SOL
await transfer(conn, { from, destination: "RECIPIENT", amount: solToLamports("0.5") });

// SPL or Token-2022: the program is detected and the recipient ATA is derived
await transfer(conn, {
  from,
  destination: "RECIPIENT",
  mint: "MINT",
  amount: parseAmount("100", 6), // bigint base units
  decimals: 6,
});
```

Amounts are always `bigint` base units; `solToLamports` / `parseAmount` / `formatAmount` convert exactly, with no floating-point error. ESM only, Node.js 20 or later.

Docs and examples: [github.com/qinheqing/solana-wallet](https://github.com/qinheqing/solana-wallet).

## License

MIT
