# cpi-program (`solwallet_cpi`)

Minimal native Solana program (framework: [pinocchio](https://github.com/anza-xyz/pinocchio),
no Anchor, no borsh) used by `@sol-wallet/core` to exercise CPI code paths:

- **PDA vault batch payouts** (task #7): `initialize_vault` + `batch_transfer`, authority-gated.
- **Token CPI forwarder** (PRD T-I, task #23): `forward_transfer_checked` CPIs
  `TransferChecked` on SPL Token / Token-2022 so the token movement shows up as an
  *inner* instruction (`meta.innerInstructions`) — the input `inspectTransaction`
  needs for CPI-originated transfers.

Client-side builders live in `packages/core/src/transfer/cpi.ts`
(`buildCpiInitializeVaultInstruction`, `buildCpiBatchTransferInstruction`,
`buildForwardTransferCheckedInstruction`, `cpiTokenTransfer`, `deployCpiProgram`).
MCP exposes `cpi_token_transfer`.

## Instructions

All integers are little-endian; the first byte is the discriminant.

| disc | instruction                | data (after disc)                             | accounts |
|------|----------------------------|-----------------------------------------------|----------|
| `0`  | `initialize_vault`         | `32B authority`                               | `[payer (s,w), vault PDA (w), system program]` |
| `1`  | `batch_transfer`           | `u16 count` + `count × (32B recipient, u64 lamports)` | `[authority (s,w), vault PDA (w), system program, recipient × count (w)]` |
| `2`  | `forward_transfer_checked` | `u64 amount` + `u8 decimals`                  | `[authority (s), source token acct (w), mint, destination token acct (w), token program, extras…]` |

`forward_transfer_checked` details:

- The token program account (index 4) must be SPL Token
  (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) or Token-2022
  (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`); anything else fails with
  custom error `0x8`.
- The CPI is `TransferChecked` (instruction index 12, data `[12, u64 amount, u8 decimals]`)
  with accounts `[source, mint, destination, authority(signer)]`. The caller's
  signature is forwarded as-is — no PDA signing.
- Accounts after the fifth are appended to the CPI with their own
  signer/writable flags (pass-through for Token-2022 TransferHook extra accounts).

Vault PDA: seeds `[b"vault"]`; 32-byte data = stored authority.

### Custom errors

| code  | meaning |
|-------|---------|
| `0x1` | vault balance too low for the payout |
| `0x2` | empty payout |
| `0x3` | invalid account layout |
| `0x4` | vault not initialized |
| `0x5` | signer is not the vault's stored authority |
| `0x6` | vault already initialized |
| `0x7` | payout would leave the vault below rent exemption |
| `0x8` | token program is neither SPL Token nor Token-2022 |

## Build

The compiled artefact `target/deploy/solwallet_cpi.so` is **not** tracked in git
(`target/` is ignored) — build it before deploying or running the mollusk tests:

```bash
export PATH=$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH
cd packages/cpi-program
cargo build-sbf          # → target/deploy/solwallet_cpi.so
```

Deploy from TypeScript with `deployCpiProgram(conn, payer, "packages/cpi-program/target/deploy/solwallet_cpi.so")`.

## Test (mollusk-svm, host build)

`tests/mollusk_tests.rs` runs the real `.so` inside `mollusk-svm`; the token
programs come from `mollusk-svm-programs-token` (bundled ELFs). `SBF_OUT_DIR`
tells mollusk where the `.so` lives.

On this machine the host C toolchain is shadowed/broken, so override it explicitly:

```bash
cd packages/cpi-program
SBF_OUT_DIR=$PWD/target/deploy \
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
RUSTFLAGS="-C linker=/usr/bin/cc" CC=/usr/bin/cc AR=/usr/bin/ar \
cargo test --release
```

Expected: `test result: ok. 9 passed` (vault/batch tests + forwarder on SPL Token,
Token-2022, invalid token program, missing signature).
