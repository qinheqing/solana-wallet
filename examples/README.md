# examples/

只用 `@sol-wallet/core` 写的端到端脚本：前三个对应 SKILL.md「组合示例」A / B / C，`wallet-primitives.ts` 覆盖账户与交易原语。每个脚本把一份 JSON 报告打到 stdout（签名、`explorerUrl`、解析结果），日志打到 stderr；密钥永远不出现在输出里。

| 脚本 | 验证什么 |
|---|---|
| `fee-mint-net-amount.ts` | transfer-fee 预设（100 bps）→ `buildTransferPlan` 四指令标准形状 → `preflightTransfer` 的 `TRANSFER_FEE` → `transfer` → `inspectTransaction` 恒等式 `amount − fee == balanceDelta`，以及收款 ATA 上的扣留费 |
| `memo-block-and-force.ts` | 收款方 `enableMemoTransfer` → 无 memo 被本地预检 `MEMO_REQUIRED` 拦下 → `force` 后链上 `NoMemo`（`error.custom.code == 36`）→ 带 memo 成功 |
| `permanent-delegate-transfer.ts` | permanent-delegate 预设：delegate 不经 owner 签名划走 victim 的币，`inspectTransaction` 里 `authority ≠ sourceOwner`；对照普通 `approveDelegate`：超额被 `INSUFFICIENT_DELEGATED_AMOUNT` 拦下，额度内成功 |
| `wallet-primitives.ts` | 账户与交易原语：`createTokenAccount` 建非 ATA 账户（Token-2022 按扩展算空间）→ `mintTokens` 铸到指定账户 → `transfer` 用 `sourceTokenAccount` / `destinationTokenAccount` 在两个非 ATA 账户间转（无建 ATA 指令）→ PermanentDelegate `burnTokens` 从别人的账户销毁（BurnChecked）→ `createLookupTable` 后用 `lookupTables` 发 v0 交易，链上 message 确认引用了 ALT → 查看并停用 ALT |

## 运行

需要一个能 airdrop 的集群。最简单是本地 validator：

```bash
# 终端 1
solana-test-validator --reset

# 终端 2（仓库根目录）
pnpm install && pnpm --filter @sol-wallet/core build
pnpm example examples/fee-mint-net-amount.ts
pnpm example examples/memo-block-and-force.ts
pnpm example examples/permanent-delegate-transfer.ts
pnpm example examples/wallet-primitives.ts
```

`pnpm example` 就是 `tsx`，`@sol-wallet/core` 从 `packages/core/dist` 解析，所以先 build。`examples/package.json` 里的 `"type": "module"` 只是让 tsx 按 ESM 运行（脚本用顶层 `await`），这个目录不是 workspace 包。启动时的 `bigint: Failed to load bindings` 警告来自 web3.js 的可选原生依赖，可忽略。

环境变量（都有默认值，不要把密钥写进脚本）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SOLWALLET_RPC_URL` | `http://127.0.0.1:8899` | RPC 端点。可以是 Helius / QuickNode 的 devnet URL；公共 devnet 端点的水龙头已关闭，付费方钱包余额不足时脚本会报 `FAUCET_UNAVAILABLE`，请先手动充值 |
| `SOLWALLET_KEYPAIR` | `~/.config/solana/id.json` | 付费方 / mint authority / delegate 的 solana-keygen keyfile。`solana-keygen new` 可生成 |

脚本里临时生成的收款方 / victim 钱包只活在进程内，需要签名的那几个会先从水龙头领 2 SOL。

## 输出

成功时 `ok: true`，`steps` 里按步骤给出可核对的字段；任何预期不成立（例如费率恒等式不成立、强制发送没有返回 `NoMemo`）脚本退出码为 1，`ok: false` 且 `error` 说明哪一步、哪个断言，已完成的步骤仍保留在 `steps` 里。

所有金额都是 raw base units 字符串（decimals = 6），没有 `uiAmount`。

## 类型检查

```bash
pnpm typecheck:examples      # 只查 examples/
pnpm typecheck               # 全仓（含 examples）
```

不需要网络；只要求 `packages/core` 已经 build 过（`pnpm -r typecheck` 本身会产出 core 的 dist）。
