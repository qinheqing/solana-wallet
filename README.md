# solana-wallet

Solana 钱包测试工具集：用自然语言驱动钱包生成、转账、批量空投、Token-2022 与多签测试。同一套核心库，三种使用形态：

- **MCP Server** — 接入 Claude Code / Cursor 等 AI 客户端，自然语言执行全部操作（stdio 传输）
- **Claude Skill** — 给 AI 的一份使用手册（`skills/solana-wallet/SKILL.md`）
- **npm 库** — `@solwallet/core`，直接 import 写测试脚本

定位是**测试工具**：密钥只活在 MCP 进程内存里，重启即清空；主网操作有显式确认守卫。不要把它当主网钱包用。

## 功能现状

| 能力 | 状态 |
|---|---|
| 钱包生成 / 导入（BIP39 助记词、solana-keygen JSON） | ✅ 可用 |
| 余额查询（SOL + SPL + Token-2022 全量） | ✅ 可用 |
| 单笔转账（SOL / SPL / Token-2022，自动识别 mint 所属程序） | ✅ 可用 |
| 批量转账（1–50 接收者，自动分块串行发送） | ✅ 可用 |
| 混合转账（一笔交易多腿：SOL + 多个 mint，单一签名） | ✅ 可用 |
| dry-run 模拟（发送前验证，返回完整日志） | ✅ 可用 |
| Token-2022 发行与运行时管理（Transfer Fee / 冻结 / 元数据） | 🚧 开发中（工具已注册，返回 `NOT_IMPLEMENTED`） |
| 多签（Squads V4，M-of-N 提案流） | 🚧 开发中 |
| Web UI | 🚧 规划中 |

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

## 工具清单（13 个）

| 工具 | 用途 | 状态 |
|---|---|---|
| `create_wallet` | 生成新钱包（BIP39，默认 12 词，可选 24 词），只载入内存 | ✅ |
| `import_wallet` | 从 keyfile JSON 或助记词导入，支持派生路径与 passphrase | ✅ |
| `list_wallets` | 列出内存中的钱包（名称 / 地址 / 来源，无密钥） | ✅ |
| `export_secret` | 导出密钥材料，必须显式传 `dangerouslyAllowSecretExport: true` | ✅ |
| `get_cluster_status` | 集群健康：slot、节点版本、近似 TPS | ✅ |
| `request_airdrop` | 水龙头请求（拒绝 mainnet-beta，其余集群交给远端） | ✅ |
| `get_balances` | 全量余额：SOL + 全部 SPL / Token-2022 账户 | ✅ |
| `transfer` | 单笔转账：SOL（省略 mint）或代币（mint + decimals 必填） | ✅ |
| `batch_transfer` | 一对多批量（1–50 接收者），按 chunkSize 分块串行发送 | ✅ |
| `mixed_transfer` | 一笔交易 2–10 条腿（SOL + 多个不同 mint），共享一个签名 | ✅ |
| `create_token` | 创建 SPL / Token-2022 mint（含扩展配置） | 🚧 返回 `NOT_IMPLEMENTED` |
| `manage_token2022` | Token-2022 运行时管理（改费率 / 冻结 / 换权限 / 元数据） | 🚧 返回 `NOT_IMPLEMENTED` |
| `create_multisig` | Squads V4 M-of-N 多签与提案流 | 🚧 返回 `NOT_IMPLEMENTED` |

转账层已支持 Token-2022：`transfer` / `batch_transfer` / `mixed_transfer` 会自动识别 mint 属于 Token Program 还是 Token-2022。开发中的是发行与管理侧。

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

金额一律走精确换算：`solToLamports` / `parseAmount` 把人类可读字符串转成 base units（bigint），精度不足直接抛 `AMOUNT_TOO_PRECISE`，不存在浮点误差。

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
│   ├── core/          # @solwallet/core — 连接、钱包、转账、金额、错误解析
│   ├── mcp/           # @solwallet/mcp — 13 个 MCP 工具，薄壳调 core
│   └── cpi-program/   # 示例 CPI 程序（规划中）
├── apps/
│   └── web/           # Web UI（规划中，任务 #13）
└── skills/
    └── solana-wallet/
        └── SKILL.md   # Claude Skill：给 AI 的使用手册
```

**核心原则：core 零 UI 依赖。** `@solwallet/core` 只依赖链上库（`@solana/web3.js`、`@solana/spl-token`、`@sqds/multisig` 等），不知道 MCP、React 或任何 AI 框架的存在。MCP、Skill、UI、未来可能的 CLI 都只是同一核心的不同壳——修一次转账逻辑，所有形态同时受益。

连接层内置确认策略（`confirmed`，30s 超时，指数退避最多 5 次重试）与确定性失败识别：链上程序错误、blockhash 过期、4xx 一律不盲目重试，网络错误与 429/5xx 才重试。

## 安全模型

- **密钥只在进程内存。** 钱包存在 MCP 服务器进程的 `WalletStore` 里，进程退出即清空，不落盘、不持久化。重启后需要重新 `create_wallet` / `import_wallet`，所以钱包需要复用时先用 `export_secret` 备份密钥。
- **输出脱敏，两层防线。** 工具本身不返回密钥；输出管线再把命中敏感键名（secret / mnemonic / private key 等）的字段值替换为 `[REDACTED]`。
- **导出逃生口。** `export_secret` 必须显式传 `dangerouslyAllowSecretExport: true`（字面量，不可省略、不可传 false），这是唯一的密钥出囗。注意：当前版本导出请用 `format: "keyfileJson"`，`format: "mnemonic"` 的输出会被脱敏层遮蔽为 `[REDACTED]`（详见下方已知问题）。
- **mainnet 守卫。** 所有发送类工具（`transfer` / `batch_transfer` / `mixed_transfer`）在 mainnet-beta 上拒绝执行，除非显式传 `allowMainnet: true`——该参数只接受字面量 `true`，AI 不会替你"顺手"确认。`request_airdrop` 在 mainnet-beta 上直接拒绝，无逃生口。
- **已知问题：** `export_secret` 的 `mnemonic` 格式会被输出脱敏层误伤（键名 `mnemonic` 命中敏感键正则），拿到的是 `[REDACTED]`；`keyfileJson` 格式正常。修复前备份一律用 `keyfileJson` 格式（与 `solana-keygen` 兼容）。

## 开发者指南

```bash
pnpm install          # 安装依赖
pnpm build            # 构建所有包（tsc，产物在各包 dist/）
pnpm test             # 91 个单元测试（vitest，全程离线，fake RPC）
pnpm typecheck        # 全仓类型检查
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

Roadmap：Token-2022 发行与管理（任务 #8/#9）→ Squads V4 多签（#10）→ npm 发布（#12.3）→ Web UI（#13）→ CPI 示例程序。
