<div align="center">

# solana-wallet

**Solana 钱包测试工具集：用自然语言跑钱包、转账、Token-2022 和多签测试。**

同一个核心库，四种用法：MCP Server · Claude Skill · Web 控制台 · TypeScript 库

[English](./README.md) · **简体中文**

![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-29_tools-7C3AED)
![Solana](https://img.shields.io/badge/Solana-devnet%20%7C%20testnet%20%7C%20localnet-9945FF?logo=solana&logoColor=white)

<img width="900" alt="Web 控制台：概览页" src="https://github.com/user-attachments/assets/e017b5b1-f9cb-4f28-a3ec-5a5c12d2532c" />

</div>

> [!WARNING]
> 这是**测试工具**，不是放真钱的钱包。MCP 的密钥只在进程内存里，Web 的密钥存在浏览器里；主网上发交易必须显式确认。

## 为什么做这个

测一个 Solana 集成，通常要在 `solana-keygen`、`spl-token`、临时脚本和区块浏览器之间来回切。碰上 Token-2022 扩展（转账费、hook、强制 memo、永久委托……）和多签，步骤更多。

接上 solana-wallet 之后，直接跟 AI 说：

```txt
在 devnet 上建 alice 和 bob 两个钱包，看看 alice 的余额。
发一个带 1% 转账费的 Token-2022 代币，给 alice 铸 1000 个，再转 100 个给 bob。
对一个要求 memo 的账户先跑预检，再解析一下失败原因。
用 alice、bob、carol 建一个 2/3 的 Squads 多签，提一笔 0.1 SOL 的转出提案。
```

## 亮点

- **三种资产都支持**：SOL、SPL Token、Token-2022，代币属于哪个程序从 mint 自动识别。
- **Token-2022 是一等公民**：发币时可带转账费、Transfer Hook、计息、不可转让、永久委托、链上元数据、默认账户状态、显示倍率扩展；发完还能在运行时管理（15 个操作）。
- **批量与混合转账**：一次发给 1–50 个地址，自动分块；或者把 SOL 和多个 mint 放进同一笔原子交易。
- **发之前先看清**：`build_transfer` 给出每条指令；`preflight_transfer` 提前查出 hook、memo、冻结、费率、委托额度等问题，分 block · warn · info 三级；`dryRun` 只模拟并返回完整日志。
- **发完说得清**：`inspect_transaction` 解析代币流向（包括 CPI 内层指令）、余额变化，以及 Token / Token-2022 的错误名。
- **原始交易通道**：别处构造的 hex / base64 交易可以拿来部分签名、模拟、发送。
- **多签**：Squads V4 M-of-N，创建 → 提案 → 批准 → 执行。
- **默认安全**：所有工具输出都会脱敏，主网发送必须传字面量 `allowMainnet: true`。

## 快速开始

需要 Node ≥ 20、pnpm ≥ 12。

```bash
git clone https://github.com/qinheqing/solana-wallet.git
cd solana-wallet
pnpm install && pnpm build
```

再按用法选：

| 我想… | 看这里 |
|---|---|
| 在 Claude Code / Cursor 等 MCP 客户端里用自然语言操作 | [MCP Server](#mcp-server) |
| 在浏览器里点着用 | [Web 控制台](#web-控制台) |
| 用 TypeScript 写测试脚本 | [作为库使用](#作为库使用) |

> [!NOTE]
> MCP Server 和库已发布到 npm：[`@sol-wallet/mcp`](https://www.npmjs.com/package/@sol-wallet/mcp)、[`@sol-wallet/core`](https://www.npmjs.com/package/@sol-wallet/core)。Web 控制台需从 clone 下来的仓库运行。

## MCP Server

**Claude Code**

```bash
claude mcp add solwallet -- npx -y @sol-wallet/mcp
```

重启 Claude Code，试试：*「新建一个叫 alice 的钱包，看下 devnet 集群状态，再查她的余额。」*

<details>
<summary><b>Cursor / Claude Desktop / 其他客户端（JSON 配置）</b></summary>

把下面这段加进客户端的 MCP 配置（`.mcp.json`、`~/.cursor/mcp.json`、`claude_desktop_config.json` 等）：

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
<summary><b>自定义 RPC（Helius / QuickNode）或本地 validator</b></summary>

```bash
# 付费 RPC
claude mcp add solwallet \
  -e SOLWALLET_CLUSTER="https://devnet.helius-rpc.com/?api-key=YOUR_KEY" \
  -- npx -y @sol-wallet/mcp

# 本地 solana-test-validator
claude mcp add solwallet \
  -e SOLWALLET_CLUSTER=http://127.0.0.1:8899 \
  -- npx -y @sol-wallet/mcp
```

</details>

**Claude Skill**：[`skills/solana-wallet/SKILL.md`](./skills/solana-wallet/SKILL.md) 是写给 AI 看的使用手册，内容有操作流程、预检代码表和端到端组合示例。和 MCP Server 一起加载，模型更容易选对工具、传对参数。

### 工具

共 29 个，分 9 组。所有发送类工具都支持 `dryRun: true`（只模拟）和 `cluster`（集群名或 RPC URL）。

<details>
<summary><b>钱包与集群（7）</b></summary>

| 工具 | 用途 |
|---|---|
| `create_wallet` | 生成 BIP39 钱包（12 或 24 词），只放在内存里；同名已存在时报错，传 `overwrite: true` 才覆盖 |
| `import_wallet` | 从 keyfile JSON 或助记词导入，支持派生路径和 passphrase |
| `list_wallets` | 列出名称、地址、来源，不含密钥 |
| `export_secret` | 导出助记词或 keyfile JSON，必须传 `dangerouslyAllowSecretExport: true` |
| `get_cluster_status` | slot、节点版本、近似 TPS |
| `request_airdrop` | 向水龙头要 SOL（mainnet-beta 上直接拒绝） |
| `get_balances` | SOL 和全部 SPL / Token-2022 账户余额 |

</details>

<details>
<summary><b>转账（3）· 构造与预检（2）</b></summary>

| 工具 | 用途 |
|---|---|
| `transfer` | 单笔 SOL 或代币转账，默认先跑预检（`force: true` 越过）；可调 compute budget、ATA 模式、指令变体、memo、委托 |
| `batch_transfer` | 1–50 个接收方，分块串行发送 |
| `mixed_transfer` | 一笔交易里 2–10 条腿（SOL 加多个不同 mint），只签一次 |
| `build_transfer` | 只构造不发送，返回 `TransactionPlan`：每条指令及其账户、数据、交易大小、签名者 |
| `preflight_transfer` | 只读检查，返回 `{ ok, findings[] }`，每条带 `code` / `severity` / `message` |

</details>

<details>
<summary><b>原始交易（3）· 观察解析（4）</b></summary>

| 工具 | 用途 |
|---|---|
| `sign_transaction` | 用已加载的钱包给 hex / base64 交易部分签名 |
| `simulate_transaction` | 模拟序列化交易，返回日志、CU 消耗和错误 |
| `send_transaction` | 发送已签满的交易，自带重试与确认 |
| `derive_address` | 离线推导 owner × mint 在两个代币程序下的 ATA |
| `inspect_mint` | decimals、供应量、各类权限，以及全部 Token-2022 扩展的解码结果 |
| `inspect_token_account` | owner、余额、delegate、状态和账户级扩展 |
| `inspect_transaction` | 按签名在线读取或用 JSON 离线解析：代币流向（识别 CPI 内层）、余额变化、错误解码 |

</details>

<details>
<summary><b>委托（2）· CPI（1）· 代币（2）· 多签（5）</b></summary>

| 工具 | 用途 |
|---|---|
| `approve_delegate` / `revoke_delegate` | 给 ATA 授权或撤销 delegate 额度 |
| `cpi_token_transfer` | 经仓库自带的 CPI 转发程序转账，让这笔流动以内层指令的形式出现 |
| `create_token` | 用 7 个预设之一或手动指定扩展创建 SPL / Token-2022 mint，可顺带铸币 |
| `manage_token2022` | 15 个运行时操作：铸造、销毁、改费率、冻结 / 解冻、换权限、改元数据、显示倍率、开关 memo、提取扣留费、换 hook 程序 |
| `create_multisig` | 创建 Squads V4 M-of-N 多签，返回多签 PDA 和金库 PDA |
| `propose_multisig` / `approve_multisig` / `execute_multisig` | 对金库转账发起提案、批准、执行 |
| `get_multisig` | 成员、阈值、金库，以及每个提案和投票情况 |

</details>

### 约定

- **金额一律用最小单位。** 传 lamports 或代币最小单位的整数字符串：1 SOL → `"1000000000"`；6 位小数的代币 1.5 个 → `"1500000"`。传 `"1.5"` 会被拒绝，返回 `INVALID_INPUT`。输出也是原始字符串，旁边附一个可读的 `*Display` 提示，比如 `"1.5 SOL"`。
- **`decimals` 可以不传。** 不传时从 mint 读取。它只用于 `transferChecked` 校验和显示，不参与金额换算。
- **错误。** 调用失败时返回 `isError: true`，正文是 `{ error: { code, message, suggestion } }`。先看 `suggestion`，里面写了该怎么改。参数问题统一是 `INVALID_INPUT`，这类请求根本没上链。
- **带签名的结果**都附 `explorerUrl`。链上程序错误另附 `error.custom = { code, name }`，例如 `36 = NoMemo`。

## Web 控制台

```bash
pnpm dev   # → http://localhost:5173
```

一个本地运行的单页控制台，底层是同一个核心库。界面可切中英文，可连 devnet、testnet、mainnet-beta 或自定义 RPC。

| 页面 | 能做什么 |
|---|---|
| 概览 | 集群状态、当前钱包、SOL 和全部代币账户 |
| 钱包 | 新建、导入、导出、删除；可设密码加密，可同时解锁多个钱包；推导 ATA |
| 转账 | 单笔、批量、混合转账，带预览、预检面板和 dry run |
| 代币 | 用预设发币；铸造、销毁，管理 Token-2022 扩展和 Metaplex 元数据 |
| 多签 | 创建或导入 Squads 多签，对金库转账发起提案、批准、执行 |
| 交易查看器 | 按签名或粘贴 `getTransaction` JSON 解析交易，可导出报告 |

<details>
<summary><b>更多截图</b></summary>

| 钱包 | 批量转账 |
|---|---|
| <img alt="钱包" src="https://github.com/user-attachments/assets/32e1c233-fbc8-497e-9058-1ea3186e1554" /> | <img alt="批量转账" src="https://github.com/user-attachments/assets/6d90c5ec-9c38-4c06-ab4e-e8fdda087136" /> |
| **代币** | **多签** |
| <img alt="代币" src="https://github.com/user-attachments/assets/7a3072c6-2bdc-4588-96a6-214c14012e62" /> | <img alt="多签" src="https://github.com/user-attachments/assets/9482bbb2-e2a2-4b71-b794-16f4c4e9dce2" /> |

</details>

> [!CAUTION]
> Web 端的钱包存在浏览器 `localStorage` 里。设了密码就加密存储（AES-256-GCM + PBKDF2-SHA256），没设就是明文。只放测试用的密钥。

## 作为库使用

```ts
import { Keypair } from "@solana/web3.js";
import { createConnection, transfer, solToLamports, parseAmount } from "@sol-wallet/core";

const conn = createConnection("devnet"); // 也可以传完整 RPC URL
const from = Keypair.fromSecretKey(/* 64 字节 secretKey */);

// SOL
await transfer(conn, { from, destination: "接收地址", amount: solToLamports("0.5") });

// SPL 或 Token-2022：自动识别程序，接收方 ATA 自动推导
await transfer(conn, {
  from,
  destination: "接收地址",
  mint: "MINT 地址",
  amount: parseAmount("100", 6), // bigint，最小单位
  decimals: 6,
});
```

`solToLamports` / `parseAmount` / `formatAmount` 在字符串和 bigint 之间做精确换算，没有浮点误差。[`examples/`](./examples/README.md) 里有三个端到端脚本，分别演示转账费净额、memo 拦截与强制发送、永久委托划转：

```bash
solana-test-validator --reset                  # 终端 1
pnpm example examples/fee-mint-net-amount.ts   # 终端 2
```

## 获取测试 SOL

devnet / testnet 的公共 RPC 水龙头目前返回 HTTP 410，`request_airdrop` 会报 `FAUCET_UNAVAILABLE`。可以改用：

1. **[faucet.solana.com](https://faucet.solana.com)**：用 GitHub 登录，粘贴地址即可领取。
2. **付费 RPC**（Helius、QuickNode 等）：它们的 devnet 端点一般还保留水龙头，设为 `SOLWALLET_CLUSTER` 或作为 `cluster` 参数传入。
3. **`solana-test-validator`**：空投不限量，完全离线，最适合 CI。

## 安全模型

- **MCP 的密钥只在内存。** 钱包放在服务进程里，重启就没了；需要保留的先用 `export_secret` 备份。
- **两层脱敏。** 敏感字段名的值替换成 `[REDACTED]`；任何字符串只要包含已加载钱包的助记词或密钥字节，在序列化之前整个替换掉。
- **唯一的导出口。** 只有 `export_secret` 加 `dangerouslyAllowSecretExport: true` 才能拿到密钥。
- **不会悄悄覆盖。** 钱包重名直接报错，除非传 `overwrite: true`。
- **主网守卫。** mainnet-beta 上发送（包括按 genesis hash 识别为主网的自定义 RPC）必须传字面量 `allowMainnet: true`；主网空投一律拒绝。

## 架构

```
packages/
  core/          @sol-wallet/core：连接、钱包、转账、代币、观察解析、多签（不依赖任何 UI）
  mcp/           @sol-wallet/mcp：29 个 MCP 工具，薄薄一层调用 core（stdio）
  cpi-program/   示例 Pinocchio 程序：带 authority 校验的金库 + transferChecked 转发
apps/web/        React + Vite 控制台
skills/          Claude Skill（SKILL.md）
examples/        只用 core 写的端到端脚本
```

`core` 不知道 MCP、React 或 AI 的存在，修一处逻辑，所有用法同时生效。连接层只对网络错误、429、5xx 重试发送；链上程序错误、blockhash 过期不会盲目重发；"already processed" 视为已成功。

## 开发

```bash
pnpm test        # 单元测试 + MCP 端到端测试（离线，fake RPC）
pnpm typecheck   # 全仓类型检查，含 examples/
pnpm build       # tsc → packages/*/dist

node packages/mcp/smoke-client.mjs   # 真实链冒烟测试（本地链请设置 SOLWALLET_CLUSTER）
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SOLWALLET_CLUSTER` | `devnet` | `devnet` / `testnet` / `mainnet-beta` 或任意 RPC URL |
| `SMOKE_MNEMONIC` | — | 冒烟脚本使用的固定助记词 |

## 路线图

- [x] 发布 `@sol-wallet/core` 和 `@sol-wallet/mcp` 到 npm（`npx @sol-wallet/mcp`）
- [ ] 继续完善 Web 控制台
