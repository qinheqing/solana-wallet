---
name: solana-wallet
description: Solana 钱包与转账测试工具集（solwallet MCP server）。当用户提到 Solana 测试、devnet / testnet / localnet 操作、生成或导入测试钱包、领测试 SOL（airdrop / 水龙头）、SOL / SPL / Token-2022 转账测试、批量转账或空投模拟、混合多币转账、查钱包余额、交易 dry-run 模拟、Token-2022 测试、多签测试时使用。通过 13 个 MCP 工具执行，本 Skill 提供工具选择决策、参数约定、标准工作流与错误自纠错规则。
---

# solana-wallet 使用手册

给 AI 的操作规范。所有操作通过 solwallet MCP server 的工具完成；服务器默认连 devnet（`SOLWALLET_CLUSTER` 可改）。密钥只存在于服务器进程内存，重启即清空——这是测试工具，不是主网钱包。

## 工具决策表

| 用户意图 | 工具 | 关键点 |
|---|---|---|
| 新建测试钱包 | `create_wallet` | 默认 12 词助记词；`strength: 256` 为 24 词；助记词不回显 |
| 用已有钱包（keyfile / 助记词） | `import_wallet` | `keyfileJson` 与 `mnemonic` 二选一，不能都传或都不传 |
| 看当前加载了哪些钱包 | `list_wallets` | 无参数，随时可调 |
| 备份 / 导出密钥 | `export_secret` | 仅用户明确要求时；用 `format: "keyfileJson"` + `dangerouslyAllowSecretExport: true` |
| 集群健康（slot / 版本 / TPS） | `get_cluster_status` | 排查连接问题的第一步 |
| 领测试 SOL | `request_airdrop` | mainnet-beta 直接拒绝；公共水龙头 410 见下文 |
| 查余额（SOL + 全部代币） | `get_balances` | 含 SPL 与 Token-2022 账户 |
| 单笔转账 | `transfer` | 代币转账 `mint` + `decimals` 必传 |
| 一对多批量 | `batch_transfer` | 1–50 接收者，自动分块串行 |
| 多资产打包一笔 | `mixed_transfer` | 2–10 条腿，共享一个签名 |
| 发送前验证 | 任何发送工具 + `dryRun: true` | 只模拟，返回日志 |
| 创建代币 / Token-2022 管理 / 多签 | `create_token` / `manage_token2022` / `create_multisig` | 🚧 均返回 `NOT_IMPLEMENTED`，不要调用，直接告知用户开发中 |

转账层（`transfer` / `batch_transfer` / `mixed_transfer`）已自动识别 mint 属于 SPL Token 还是 Token-2022，无需指定程序。

## 参数约定

- **金额一律是人类可读字符串**：`"1.5"`、`"0.01"`。不要传 lamports / base units，不要用科学计数法，不要传数字类型。内部精确换算，精度超出 decimals 会报 `AMOUNT_TOO_PRECISE`。
- **decimals 只在代币转账时传**：`transfer` 带 `mint` 时 `decimals` 必传（0–18，链上 transferChecked 校验）；SOL 转账传 `decimals` 会直接报错。
- **`walletName` vs `address`**：操作已加载的钱包用 `walletName`；操作外部地址（如给任意地址查余额、空投）用 `address`。二者提供其一。
- **`cluster`**：可选，接受官方名（`devnet` / `testnet` / `mainnet-beta`）或**完整 RPC URL**（含 `http://127.0.0.1:8899`）。省略时用服务器默认。临时换集群不需要用户改配置，直接在调用里传 URL。
- **`allowAtaCreation`**（仅 `transfer`）：默认 `true`，接收方无代币账户时自动创建（约 0.002 SOL 租金，由发送方支付）。接收方是程序派生地址等特殊场景才需要关掉。
- **`dryRun: true`**：金额大、接收者多、指令复杂时先模拟一次，看 `logs` 里有没有报错再真发。
- **`allowMainnet: true`**（字面量）：mainnet-beta 上所有发送类工具的硬性确认。真实资金。**必须先向用户复述金额、接收地址并得到确认，才能传这个参数。**
- **`dangerouslyAllowSecretExport: true`**（字面量）：导出密钥的唯一逃生口。仅当用户明确要求备份或导出时使用；导出后提醒用户安全保存。

## 工作流剧本

### 剧本一：新建钱包 → airdrop → 转账 → 查余额

```
create_wallet   { "name": "alice" }                      → 记下 address
request_airdrop { "walletName": "alice", "sol": "2" }    → signature
create_wallet   { "name": "bob" }                        → 记下 address
transfer        { "walletName": "alice", "to": "<bob地址>", "amount": "0.5" }
get_balances    { "walletName": "alice" }
get_balances    { "walletName": "bob" }                  → 应 ≈ 0.5 SOL
```

airdrop 失败（`FAUCET_UNAVAILABLE`）走下文水龙头章节，不要反复重试。

### 剧本二：批量空投（SOL 或同一种代币）

```
batch_transfer {
  "walletName": "alice",
  "recipients": [
    { "to": "<地址1>", "amount": "0.01" },
    { "to": "<地址2>", "amount": "0.02" },
    { "to": "<地址3>", "amount": "0.03" }
  ],
  "dryRun": true          ← 接收者多时先模拟
}
```

- 每个接收者金额独立；代币空投加 `mint` + `decimals`（省略 mint 即 SOL）。
- 上限 50 个接收者，更多则分多次调用。
- 默认每 5 条指令打成一笔交易（`chunkSize` 可调 1–10），**串行发送**：某块失败立即停止，后续块标记 skipped——根据返回中各 chunk 的报告修复后，从未完成的接收者继续，不要整批重发。

### 剧本三：混合转账（一笔交易多资产）

```
mixed_transfer {
  "walletName": "alice",
  "legs": [
    { "kind": "sol",   "to": "<地址A>", "amount": "1" },
    { "kind": "token", "to": "<地址B>", "amount": "50", "mint": "<MINT地址>", "decimals": 6 }
  ]
}
```

- `sol` 腿不带 `mint`/`decimals`；`token` 腿两者都必须带，否则报错。
- 2–10 条腿打成一个交易、一个签名；任何一条腿失败则整笔失败（`dryRun` 先验证是明智的）。

## 错误处理：先读 `error.suggestion`，不要盲目重试

失败时返回结构化错误 `{ "error": { "code", "message", "suggestion" } }`。`suggestion` 是修复建议，按它行动：

| code | 含义 | 正确动作 |
|---|---|---|
| `MAINNET_NOT_ALLOWED` | 主网操作未确认 | 向用户确认后加 `allowMainnet: true` 重发 |
| `AIRDROP_NOT_SUPPORTED` | mainnet 上请求 airdrop | 主网只能转账充值，不要重试 |
| `FAUCET_UNAVAILABLE` | 公共水龙头已关闭（410） | 见下文水龙头章节，换路径 |
| `INSUFFICIENT_FUNDS` | 余额不够（金额/租金/手续费） | `get_balances` 核实，先补资金或调低金额 |
| `ACCOUNT_NOT_FUNDED` | 收款地址从未有过资金 | 先转一小笔 SOL，或保持 ATA 自动创建 |
| `ACCOUNT_NOT_FOUND` | mint / 账户在链上不存在 | 核对 cluster 与 mint 地址 |
| `ACCOUNT_OWNER_MISMATCH` | 代币转账把 ATA 地址当钱包地址传了 | `to` 传钱包地址，ATA 会自动派生 |
| `AMOUNT_TOO_PRECISE` / `DECIMALS_INVALID` / `AMOUNT_INVALID` | 金额格式问题 | 按 decimals 截断或修正格式后再发 |
| `BLOCKHASH_EXPIRED` | 区块哈希过期 | 重新调用工具即可（每次调用取新 blockhash） |
| `TRANSACTION_FAILED` | 链上程序执行失败 | 确定性失败，重发无效；`dryRun: true` 看日志修参数 |
| `RATE_LIMITED` | RPC 限流（429） | 等几秒再试；频繁出现建议换付费 RPC |
| `SEND_FAILED` | 重试耗尽仍失败 | 按 suggestion 排查（RPC 健康 / 余额）后再试 |
| `UNKNOWN` | 未识别错误 | 读 `message` 自行判断 |

原则：同一调用原样重试**最多一次**（仅限 `RATE_LIMITED` / `BLOCKHASH_EXPIRED` / 网络类错误）。其余情况先修参数；重试前用 `list_wallets` / `get_balances` / `get_cluster_status` 核实状态。

## 水龙头现状与备选方案（2026-11）

devnet / testnet 的**公共 RPC 水龙头已关闭**（返回 410），`request_airdrop` 会报 `FAUCET_UNAVAILABLE`。三条替代路径，按场景推荐：

1. **网页水龙头**：让用户到 [faucet.solana.com](https://faucet.solana.com) 用 GitHub 验证领取（把目标地址粘进去）。领完直接 `get_balances` 确认。
2. **付费 RPC**：Helius / QuickNode 的 devnet 端点通常保留水龙头（单次上限约 5 SOL）。把完整 URL 作为 `cluster` 参数直接传给 `request_airdrop`，例如 `cluster: "https://devnet.helius-rpc.com/?api-key=<KEY>"`。
3. **本地 validator**（离线、无限量、最适合批量测试）：用户运行 `solana-test-validator` 后，所有工具调用传 `cluster: "http://127.0.0.1:8899"`（或建议用户把 `SOLWALLET_CLUSTER` 环境变量设为该地址，免去每次传参）。本地 validator 自带水龙头，`request_airdrop` 不受限。

## 红线

1. 用户没有明确要求备份 / 导出，**绝不调用 `export_secret`**。
2. mainnet-beta 的任何发送：先向用户复述金额与接收地址，得到确认后才传 `allowMainnet: true`。
3. 密钥材料一旦导出，不在回复正文中复述助记词内容，只提示保存方式。
4. `create_token` / `manage_token2022` / `create_multisig` 是占位（返回 `NOT_IMPLEMENTED`），不要调用；直接告知用户对应功能开发中。
5. `export_secret` 备份用 `format: "keyfileJson"`（与 `solana-keygen` 兼容）；`format: "mnemonic"` 当前会被输出脱敏层遮蔽为 `[REDACTED]`。
