# solana-wallet

Solana 钱包测试工具集：用自然语言驱动钱包生成、转账、批量空投、Token-2022 与多签测试。同一套核心库，三种使用形态：

- **MCP Server** — 接入 Claude Code / Cursor 等 AI 客户端，自然语言执行全部操作（stdio 传输）
- **Claude Skill** — 给 AI 的一份使用手册（`skills/solana-wallet/SKILL.md`）
- **npm 库** — `@solwallet/core`，直接 import 写测试脚本

定位是**测试工具**：密钥只活在 MCP 进程内存里，重启即清空；主网操作有显式确认守卫。不要把它当主网钱包用。

## 功能截图
<img width="1239" height="786" alt="image" src="https://github.com/user-attachments/assets/e017b5b1-f9cb-4f28-a3ec-5a5c12d2532c" />

<img width="1237" height="856" alt="image" src="https://github.com/user-attachments/assets/32e1c233-fbc8-497e-9058-1ea3186e1554" />

<img width="1239" height="743" alt="image" src="https://github.com/user-attachments/assets/6d90c5ec-9c38-4c06-ab4e-e8fdda087136" />

<img width="1229" height="854" alt="image" src="https://github.com/user-attachments/assets/7a3072c6-2bdc-4588-96a6-214c14012e62" />

<img width="1241" height="824" alt="image" src="https://github.com/user-attachments/assets/9482bbb2-e2a2-4b71-b794-16f4c4e9dce2" />



## 功能现状

| 能力 | 状态 |
|---|---|
| 钱包生成 / 导入（BIP39 助记词、solana-keygen JSON） | ✅ 可用 |
| 余额查询（SOL + SPL + Token-2022 全量） | ✅ 可用 |
| 单笔转账（SOL / SPL / Token-2022，自动识别 mint 所属程序） | ✅ 可用 |
| 批量转账（1–50 接收者，自动分块串行发送） | ✅ 可用 |
| 混合转账（一笔交易多腿：SOL + 多个 mint，单一签名） | ✅ 可用 |
| dry-run 模拟（发送前验证，返回完整日志） | ✅ 可用 |
| Token 发行（SPL / Token-2022，含 Transfer Fee、Transfer Hook、计息、不可转让、永久委托、链上元数据、默认冻结扩展） | ✅ 可用 |
| Token 运行时管理（铸造 / 销毁 / 改费率 / 冻结解冻 / 换权限 / 改元数据 / 显示倍率 / MemoTransfer / 扣留费提取 / 改 hook 程序） | ✅ 可用 |
| 代币预设（`plain-2022` / `transfer-fee` / `permanent-delegate` / `scaled-ui` / `transfer-hook` / `legacy-spl` / `memo-required`）+ 一步 `mintTo` | ✅ 可用 |
| 观察：ATA 推导（离线）、mint 扩展解码、代币账户扩展解码 | ✅ 可用 |
| 构造旋钮：compute budget / ataMode / 指令变体（transfer、transferCheckedWithFee）/ memo / 委托权限；只构造不发送（`TransactionPlan`） | ✅ 可用 |
| 转账预检（transfer hook / memo / 冻结 / 不可转让 / 余额 / 费率 / 委托额度，block · warn · info）+ `force` 越过 | ✅ 可用 |
| 原始交易通道（hex / base64：部分签名、模拟、发送） | ✅ 可用 |
| 交易解析（代币流动、手续费、余额差、Token / Token-2022 错误枚举名；签名在线或 JSON 离线） | ✅ 可用 |
| 委托划转（approve / revoke；delegate 与 PermanentDelegate 用 `sourceOwner` 划转） | ✅ 可用 |
| 多签（Squads V4，M-of-N：创建 → 提案 → 批准 → 执行 → 查询） | ✅ 可用 |
| Web UI（`apps/web`） | 🚧 已有实现，仍在完善 |
| `examples/`：三个纯 core 端到端脚本（费率净额、Memo 拦截与绕过、PermanentDelegate 划转） | ✅ 可用 |

## 30 秒上手

要求：Node ≥ 20，pnpm ≥ 12。

```bash
git clone https://github.com/qinheqing/solana-wallet.git
cd solana-wallet
pnpm install && pnpm build
```

把 MCP server 加进 Claude Code（路径换成你的绝对路径）：

```bash
claude mcp add solwallet -- node /绝对路径/solana-wallet/packages/mcp/dist/cli.js
```

重启 Claude Code，第一句话：

> 帮我新建一个钱包叫 alice，在 devnet 上看看集群状态，然后查它的余额

## MCP 配置

两种方式任选其一。

**方式一：`claude mcp add` 命令**

```bash
# 默认 devnet
claude mcp add solwallet -- node /绝对路径/solana-wallet/packages/mcp/dist/cli.js

# 指定默认集群或自定义 RPC（Helius / QuickNode）
claude mcp add solwallet \
  -e SOLWALLET_CLUSTER=https://devnet.helius-rpc.com/?api-key=YOUR_KEY \
  -- node /绝对路径/solana-wallet/packages/mcp/dist/cli.js
```

**方式二：项目根目录 `.mcp.json`**

```json
{
  "mcpServers": {
    "solwallet": {
      "command": "node",
      "args": ["/绝对路径/solana-wallet/packages/mcp/dist/cli.js"],
      "env": {
        "SOLWALLET_CLUSTER": "devnet"
      }
    }
  }
}
```

`SOLWALLET_CLUSTER` 接受三种值：官方集群名（`devnet` / `testnet` / `mainnet-beta`）、完整 RPC URL、本地 validator 地址（`http://127.0.0.1:8899`）。

> npm 包（`@solwallet/mcp`）发布后可直接 `npx @solwallet/mcp` 启动，无需 clone 仓库；当前版本请用上面的 node 路径方式。

## 能力矩阵

同一能力在三种形态里的入口。core API 都从 `@solwallet/core` 导出；Web 页面路径见 `apps/web`。

| 能力 | core API | MCP 工具 | Web 页面 |
|---|---|---|---|
| 钱包生成 / 导入 / 导出 | `generateWallet` `parseKeypairJson` `newMnemonic` `importFromMnemonic` | `create_wallet` `import_wallet` `list_wallets` `export_secret` | Wallets（`/wallet`） |
| 集群健康 / 水龙头 / 余额 | `ClusterConnection.getHealth` `.requestAirdrop` `getWalletBalance` | `get_cluster_status` `request_airdrop` `get_balances` | Dashboard（`/`） |
| 单笔 / 批量 / 混合转账 | `transfer` `executeBatchTransfer` `executeMixedTransfer` | `transfer` `batch_transfer` `mixed_transfer` | Transfer（`/transfer`） |
| 构造旋钮与交易计划 | `buildTransferPlan` `planFromInstructions` `TransactionPlan` | `build_transfer`（`transfer` 同名参数） | Transfer → 高级构造 / 预览 |
| 转账预检 | `preflightTransfer` `evaluatePreflight` `PreflightCode` | `preflight_transfer`（`transfer` 默认先跑；`force` 越过） | Transfer → 预览面板 |
| 原始交易通道 | `signTransactionHex` `simulateRaw` `sendRaw` | `sign_transaction` `simulate_transaction` `send_transaction` | — |
| ATA 推导 | `deriveTokenAddresses` | `derive_address` | Wallets → 地址工具卡片 |
| mint / 代币账户观察 | `inspectMint` `inspectTokenAccount` | `inspect_mint` `inspect_token_account` | Tokens → mint 详情 |
| 交易解析与错误解码 | `inspectTransaction` `decodeInstructionError` `parseTransactionError` | `inspect_transaction` | 交易查看器（`/inspect`） |
| 建 mint（含预设） | `createSplToken` `createToken2022` `createFromPreset` `TOKEN_PRESETS` | `create_token`（`preset` / `mintTo`） | Tokens → 发币（快速模板） |
| 代币运行时管理 | `mintTokens` `burnTokens` `setTransferFee` … `enableMemoTransfer` `withdrawWithheldFromAccounts` `updateTransferHookProgram` | `manage_token2022`（15 个 action） | Tokens → 管理 |
| 委托 | `approveDelegate` `revokeDelegate`；`transfer` + `sourceOwner`/`authority` | `approve_delegate` `revoke_delegate`；`transfer` + `sourceOwner` | — |
| CPI 内层转账 | `cpiTokenTransfer` `deployCpiProgram`（`packages/cpi-program`） | `cpi_token_transfer` | — |
| 多签 | `createMultisig` `createMultisigProposal` `approveMultisigProposal` `executeMultisigProposal` `getMultisigState` `listProposals` | `create_multisig` `propose_multisig` `approve_multisig` `execute_multisig` `get_multisig` | Multisig（`/multisig`） |

脚本化的组合链路（建 mint → build → preflight → transfer → inspect）见 `examples/`；给 AI 的同一链路写在 `skills/solana-wallet/SKILL.md`「组合示例」。

## 工具清单（29 个）

| 工具 | 用途 |
|---|---|
| `create_wallet` | 生成新钱包（BIP39，默认 12 词，可选 24 词），只载入内存；同名已存在时报错，`overwrite: true` 才覆盖 |
| `import_wallet` | 从 keyfile JSON 或助记词导入，支持派生路径与 passphrase；同样受 `overwrite` 保护 |
| `list_wallets` | 列出内存中的钱包（名称 / 地址 / 来源，无密钥） |
| `export_secret` | 导出密钥材料（`mnemonic` 或 `keyfileJson`），必须显式传 `dangerouslyAllowSecretExport: true` |
| `get_cluster_status` | 集群健康：slot、节点版本、近似 TPS |
| `request_airdrop` | 水龙头请求，`lamports` 传 base units（拒绝 mainnet-beta，其余集群交给远端） |
| `get_balances` | 全量余额：SOL + 全部 SPL / Token-2022 账户（raw `solLamports` / `amount` + `solDisplay` / `display` 提示） |
| `transfer` | 单笔转账：SOL（省略 mint，`amount` 为 lamports）或代币（传 mint，`amount` 为 base units，decimals 可省、自动从 mint 读）。默认先预检，block 级发现返回 `PREFLIGHT_BLOCKED`（`force: true` 越过）；接受构造旋钮 `computeUnitLimit` / `computeUnitPrice` / `ataMode` / `instruction` / `fee` / `memo` / `sourceOwner` / `authorityWallet`；返回 `plan` 与 `preflight` |
| `batch_transfer` | 一对多批量（1–50 接收者），按 chunkSize 分块串行发送 |
| `mixed_transfer` | 一笔交易 2–10 条腿（SOL + 多个不同 mint），共享一个签名 |
| `build_transfer` | 只构造不签不发：返回 `TransactionPlan`（每条指令的 label / programId / accounts / dataHex、message hex、估算字节、signers、blockhash） |
| `preflight_transfer` | 发送前读链判定：`{ ok, findings[] }`，每条 `code` / `severity`（block · warn · info）/ `message` / `data`；见 SKILL.md 预检代码表 |
| `sign_transaction` | 对 hex / base64 序列化交易用已加载钱包部分签名，返回新交易与各签名槽、`fullySigned` |
| `simulate_transaction` | 模拟序列化交易，返回 ok / logs / unitsConsumed / err |
| `send_transaction` | 发送已签满的序列化交易（走重试 / 确认策略）；未签满拒绝 |
| `derive_address` | 离线推导 owner × mint 在 legacy 与 Token-2022 两个程序下的 ATA（各带 programId、isOffCurve） |
| `inspect_mint` | 读 mint：程序、decimals、supply、authorities、全部 Token-2022 扩展解码（费率两档 + 扣留、PermanentDelegate、TransferHook、ScaledUiAmount、元数据、计息、默认状态……）、`accountLen` |
| `inspect_token_account` | 读代币账户：owner、mint、amount（raw）、delegate、state、账户级扩展（MemoTransfer、ImmutableOwner、CpiGuard、TransferFeeAmount 扣留）、dataLength |
| `inspect_transaction` | 解析交易（签名在线取或 getTransaction JSON 离线）：`movements[]`（程序、指令类型、是否 CPI 内层、source/dest 及 owner、authority、声明金额、fee、balanceDelta）、`balanceChanges[]`、`decodedError`（Token / Token-2022 枚举名）、warnings |
| `approve_delegate` | owner 给某 mint 的 ATA 授权 delegate 额度（ApproveChecked） |
| `revoke_delegate` | 撤销 delegate |
| `cpi_token_transfer` | 经已部署的 `solwallet_cpi` 转发程序发 transferChecked，使代币流动成为 CPI 内层指令（供 `inspect_transaction` 的 `isInner` 解析测试）；`programId` 必传 |
| `create_token` | 创建 SPL 或 Token-2022 mint；`preset` 填默认值（7 个模板）；Token-2022 可带 `extensions`（transferFeeConfig / transferHook / interestBearingConfig / nonTransferable / permanentDelegate / tokenMetadata / defaultAccountState / scaledUiAmount）；`mintTo` 一步铸给指定钱包 |
| `manage_token2022` | 运行时管理：`mintTokens` / `burnTokens`（SPL 与 Token-2022 通用），`setTransferFee` / `freezeAccount` / `thawAccount` / `setMintAuthority` / `setFreezeAuthority` / `updateMetadata` / `updateScaledUiMultiplier` / `enableMemoTransfer` / `disableMemoTransfer` / `withdrawWithheldFromAccounts` / `harvestWithheldToMint` / `withdrawWithheldFromMint` / `updateTransferHookProgram`（Token-2022） |
| `create_multisig` | 创建 Squads V4 M-of-N 多签，返回 `multisigPda`（后续工具要用）与 `vaultPda`（往这里打钱） |
| `propose_multisig` | 从多签金库发起一笔 SOL / 代币转账提案，返回 `transactionIndex` |
| `approve_multisig` | 成员对提案投赞成票；达到阈值后 `executeReady: true` |
| `execute_multisig` | 执行已达阈值的提案 |
| `get_multisig` | 只读查询：成员、阈值、金库地址、全部提案及其状态与投票人 |

所有发送类工具都支持 `dryRun: true`（只模拟，返回日志）与 `cluster` 参数（官方集群名或完整 RPC URL）；mainnet-beta 上必须传字面量 `allowMainnet: true`。

转账层自动识别 mint 属于 Token Program 还是 Token-2022，无需指定程序。

MCP 输出里的金额一律是 raw base units 字符串，**不含 `uiAmount`**；较大的金额旁边附一个 `*Display` 可读提示（`amountDisplay`、`solDisplay`、`feeDisplay`、`expectedFeeDisplay` / `netDisplay`、`supplyDisplay`、`balanceDeltaDisplay`、余额里的 `display`，形如 `"1.5 SOL"` / `"0.25 (6 dp)"`）；每个带签名的结果附 `explorerUrl`；链上程序错误附 `error.custom = { code, name }`（如 36 = `NoMemo`、31 = `MintMismatch`）。

### 金额单位：全部 base units

**所有工具的所有金额输入都是 base units 整数字符串**（lamports / 代币最小单位，和区块浏览器一致），没有人类可读的字段。传 `"1.5"` 会被 schema 拒绝并提示 `INVALID_INPUT`：

| 资产 | 换算 | 例子 |
|---|---|---|
| SOL | `lamports = SOL × 10^9` | 1 SOL → `"1000000000"`，0.01 SOL → `"10000000"` |
| 代币 | `base units = 数量 × 10^decimals` | 6 位小数的代币 1.5 个 → `"1500000"` |

适用：`transfer` / `build_transfer` / `preflight_transfer` / `cpi_token_transfer` / `approve_delegate` / `propose_multisig` 的 `amount`、`batch_transfer.recipients[].amount`、`mixed_transfer.legs[].amount`（sol 腿是 lamports）、`request_airdrop.lamports`、`create_token.mintTo.amount` 与 `extensions.transferFeeConfig.maximumFee`、`manage_token2022.params.amount` / `params.maximumFee`、`fee`。

代币工具的 `decimals` 可选：省略时自动从 mint 读取（多一次 RPC 读），传了就省这次读；它只用于链上 `transferChecked` 校验与 `*Display` 提示，**不参与金额换算**。

### 返回值约定：`isError` 与 `error`

- 工具抛错（参数错误、RPC 失败、发送失败）：返回 `isError: true`，正文是 `{ "error": { "code", "message", "suggestion" } }`。
- 工具没抛错但结果本身表示失败（正文带非空 `error` 字段，或 `ok: false`，例如 dry-run 模拟失败、`create_token` / `manage_token2022` / `mixed_transfer` 的链上失败、`batch_transfer` 的某块失败）：同样标记 `isError: true`，正文原样保留（日志、已成功的块等信息都在）。
- 调用方不要只看 `isError`：先读正文 `error.suggestion`（它说明怎么修），再决定重试还是改参数。
- 输入类错误（钱包不存在、地址非 base58、代币腿缺 mint、金额不是 base units 整数串、同名钱包冲突等）统一 `code: "INVALID_INPUT"`，建议指向检查参数，不会让你去区块浏览器找交易——这类错误根本没有上链。

## 作为 npm 库使用

不接 AI 客户端也可以直接用核心库写测试脚本：

```ts
import { Keypair } from "@solana/web3.js";
import { createConnection, transfer, solToLamports, parseAmount } from "@solwallet/core";

const conn = createConnection("devnet");           // 也可以传 Helius / QuickNode 完整 URL
const from = Keypair.fromSecretKey(/* 64 字节 secretKey */);

// SOL 转账
const res = await transfer(conn, {
  from,
  destination: "接收钱包地址",
  amount: solToLamports("0.5"),                    // bigint，lamports
});
console.log(res.signature, res.feeLamports);

// 代币转账（SPL 或 Token-2022，自动识别程序）
await transfer(conn, {
  from,
  destination: "接收钱包地址",                      // 传钱包地址，ATA 自动派生
  mint: "MINT 地址",
  amount: parseAmount("100", 6),                   // bigint，base units
  decimals: 6,
});
```

core 的 API 直接收 base units（bigint）；`solToLamports` / `parseAmount` / `formatAmount` 是给脚本和 UI 用的精确换算（string + bigint，精度不足直接抛 `AMOUNT_TOO_PRECISE`，不存在浮点误差）。MCP 层不做换算，输入即 base units。

完整的"建 mint → `buildTransferPlan` → `preflightTransfer` → `transfer` → `inspectTransaction`"链路见 `examples/`（三个脚本，`pnpm example examples/<name>.ts`，对本地 `solana-test-validator` 运行，输出 JSON 报告；说明见 `examples/README.md`）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SOLWALLET_CLUSTER` | `devnet` | 默认集群：官方名或完整 RPC URL（含本地 validator 的 http URL） |
| `SOLWALLET_RPC_URL` | — | 预留。错误提示文案中引用了这个名字，但当前版本代码未读取它；要指定自定义 RPC，把 URL 作为工具的 `cluster` 参数传入，或将 `SOLWALLET_CLUSTER` 设为完整 URL |

冒烟脚本另有 `SMOKE_MNEMONIC`（固定 alice 地址用），见开发者指南。

## 获取测试 SOL

现状（2026-11）：**devnet / testnet 的公共 RPC 水龙头已关闭**（`requestAirdrop` 返回 410）。调用 `request_airdrop` 会得到 `FAUCET_UNAVAILABLE` 错误。三条可行路径：

**1. 网页水龙头（推荐，零配置）**

到 [faucet.solana.com](https://faucet.solana.com) 用 GitHub 账号验证后领取，把地址粘进去即可。拿到的 SOL 已经在链上，直接 `get_balances` 能看到。

**2. 付费 RPC 提供商**

Helius、QuickNode 等的 devnet 端点通常保留水龙头。把 RPC URL 作为 `cluster` 参数传入（或写进 `SOLWALLET_CLUSTER`），`request_airdrop` 即走该端点。

**3. 本地 validator（离线全流程）**

```bash
# 安装 Solana 工具链后（https://docs.anza.xyz/cli/install）
solana-test-validator
```

然后让 MCP 指向本地：

```bash
claude mcp add solwallet \
  -e SOLWALLET_CLUSTER=http://127.0.0.1:8899 \
  -- node /绝对路径/solana-wallet/packages/mcp/dist/cli.js
```

本地 validator 自带水龙头，`request_airdrop` 不限量、无 410 问题，适合 CI 与批量空投测试。

`request_airdrop` 只拦 mainnet-beta；其余集群是否真有水龙头由远端决定。

## 架构

```
solana-wallet/
├── packages/
│   ├── core/          # @solwallet/core — 连接、钱包、转账（构造 / 预检 / 原始通道 / 委托）、代币（预设 / 管理）、观察与解析、多签
│   ├── mcp/           # @solwallet/mcp — 29 个 MCP 工具（钱包 7 / 发送 3 / 构造预检 2 / 原始交易 3 / 观察解析 4 / 委托 2 / CPI 1 / 代币 2 / 多签 5），薄壳调 core
│   └── cpi-program/   # 示例 CPI 程序（带 authority 校验的金库 + forward_transfer_checked 转发）
├── apps/
│   └── web/           # Web UI（仍在完善）
├── examples/          # 纯 core 端到端脚本（tsx），输出 JSON 报告
└── skills/
    └── solana-wallet/
        └── SKILL.md   # Claude Skill：给 AI 的使用手册
```

**核心原则：core 零 UI 依赖。** `@solwallet/core` 只依赖链上库（`@solana/web3.js`、`@solana/spl-token`、`@sqds/multisig` 等），不知道 MCP、React 或任何 AI 框架的存在。MCP、Skill、UI、未来可能的 CLI 都只是同一核心的不同壳——修一次转账逻辑，所有形态同时受益。

连接层内置确认策略（`confirmed`；只对发送做指数退避最多 5 次重试，确认只做一次并以交易自身 blockhash 判定过期，30s 确认超时后不重发、错误带签名可轮询）与确定性失败识别：链上程序错误、blockhash 过期、4xx 一律不盲目重试，网络错误与 429/5xx 才重试；"already processed" 视为已上链直接进入确认。自定义 RPC URL 会按 genesis hash 识别主网，与 `mainnet-beta` 一样受 `allowMainnet` 守卫。

## 安全模型

- **密钥只在进程内存。** 钱包存在 MCP 服务器进程的 `WalletStore` 里，进程退出即清空，不落盘、不持久化。重启后需要重新 `create_wallet` / `import_wallet`，所以钱包需要复用时先用 `export_secret` 备份密钥。
- **输出脱敏，两层防线。** 工具本身不返回密钥；输出管线再做两件事：命中敏感键名（secret / mnemonic / private key 等）的字段值替换为 `[REDACTED]`；任何字符串值只要**包含**当前内存中任一钱包的助记词或 secretKey 字节串，整个值替换为 `[REDACTED]`。密钥集合每次输出时实时读取，导入得再晚也在保护范围内；替换在序列化之前完成，输出始终是合法 JSON。
- **导出逃生口。** `export_secret` 必须显式传 `dangerouslyAllowSecretExport: true`（字面量，不可省略、不可传 false），这是唯一绕过脱敏层的出口，`mnemonic` 与 `keyfileJson` 两种格式都返回真实内容。
- **同名不覆盖。** `create_wallet` / `import_wallet` 遇到已加载的同名钱包直接报错（`INVALID_INPUT`），不会悄悄把旧密钥顶掉；确实要替换时传 `overwrite: true`。
- **mainnet 守卫。** 所有发送类工具（转账、代币、多签）在 mainnet-beta 上拒绝执行，除非显式传 `allowMainnet: true`——该参数只接受字面量 `true`，AI 不会替你"顺手"确认。`request_airdrop` 在 mainnet-beta 上直接拒绝，无逃生口。

## 开发者指南

```bash
pnpm install          # 安装依赖
pnpm build            # 构建所有包（tsc，产物在各包 dist/）
pnpm test             # 全部单元测试（vitest，全程离线，fake RPC）
pnpm --filter @solwallet/mcp test   # 只跑 MCP 端到端测试
pnpm typecheck        # 全仓类型检查（含 examples/）
pnpm typecheck:examples             # 只查 examples/
pnpm example examples/fee-mint-net-amount.ts   # 对本地 validator 跑一个示例脚本
```

真实链上冒烟（走 devnet 公共 RPC，注意水龙头 410 问题，建议配本地 validator 或付费 RPC 后再跑）：

```bash
node packages/mcp/smoke-client.mjs

# 换集群 / 固定 alice 地址
SOLWALLET_CLUSTER=http://127.0.0.1:8899 node packages/mcp/smoke-client.mjs
SMOKE_MNEMONIC="你的测试助记词" node packages/mcp/smoke-client.mjs
```

脚本依次执行：握手 → 建两个钱包 → 验证 `export_secret` 被拒 → 集群状态 → airdrop → 转账 → 批量 → 错误路径（负数金额）。

项目管理用 Task Master（工作流见 `.taskmaster/CLAUDE.md`）：

```bash
task-master list      # 全部任务与状态
task-master next      # 下一个可做任务
task-master show 12   # 查看某任务详情
```

Roadmap：npm 发布（#12.3，待定）→ Web UI 完善（#13）。
