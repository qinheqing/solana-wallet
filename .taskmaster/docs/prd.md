# PRD: Solana Wallet 测试工具（solana-wallet）

## 1. 概述

一个面向开发者的 Solana 钱包测试工具集，用于在 Solana mainnet / devnet / testnet 上测试钱包与代币相关功能。项目以 **monorepo** 形式组织，核心逻辑为纯 TypeScript 库，并对外提供三种使用形态：

1. **MCP Server** — 任何支持 MCP 的 AI 客户端（Claude Code、Cursor 等）安装后即可通过自然语言驱动全部功能
2. **Claude Skill** — 放入 `.claude/skills/` 即可让 AI 按照最佳实践调用核心库
3. **Web UI** — 浏览器图形界面，手动操作测试

**核心原则**：所有功能共享同一个核心库（`packages/core`），MCP、Skill、UI、CLI 只是不同的"壳"。核心库不依赖任何 UI 或 AI 框架。

## 2. 目标用户与场景

- Solana 程序开发者：需要批量测试转账、CPI、多签等链上行为
- 代币发行方：需要测试 SPL / Token2022（含插件）的发行与治理
- AI 辅助开发：开发者把仓库喂给 AI，让 AI 直接代为执行测试操作

## 3. 功能需求

### F1 分发与安装形态

- F1.1 提供 MCP Server（stdio 传输），通过 `npx` 即可运行；在 README 中提供一段可直接粘贴到 `claude mcp add` / `.mcp.json` 的配置
- F1.2 提供 Claude Skill 定义文件（SKILL.md），描述何时使用哪个核心功能与参数约定
- F1.3 核心库发布为 npm 包（`@solwallet/core` 或类似命名），可被独立 import
- F1.4 README 提供 5 分钟上手指南：clone → install → 配置 RPC → 让 AI 接管

### F2 网络连接（Cluster 管理）

- F2.1 支持 mainnet-beta / devnet / testnet 三官方集群 + 自定义 RPC URL（如 Helius、QuickNode）
- F2.2 连接健康检查：获取 slot、版本、TPS 等状态信息
- F2.3 支持 devnet/testnet 的 SOL 水龙头请求（airdrop）
- F2.4 交易确认策略可配置（confirmed / finalized，超时与重试）
- F2.5 mainnet-beta 连接默认允许，但任何**签名/发送**操作需要显式传 `allowMainnet: true` 风险确认参数

### F3 钱包管理

- F3.1 生成新钱包（Ed25519 keypair），返回地址与 JSON 密钥文件
- F3.2 从 JSON 密钥文件导入（solana-keygen 兼容格式：`[byte array]`）
- F3.3 从助记词导入（BIP39，支持派生路径配置，默认 `m/44'/501'/0'/0'`）
- F3.4 导出钱包为 JSON 文件（与 `solana-keygen` / `solana-cli` 兼容，可直接被 `solana accounts` 使用）
- F3.5 钱包余额查询（SOL 与全部 SPL/Token2022 资产列表）
- F3.6 钱包密钥文件支持可选密码加密存储（AES-256-GCM）；导出明文需显式确认

### F4 转账功能

- F4.1 **普通转账**：SOL（System Program）；SPL Token（Token Program）；Token2022（Token-2022 Program）——自动识别 mint 属于哪个 Program
- F4.2 **批量转账**：单一代币向 N 个接收者的批量转账；智能分批（单笔交易≤指令上限/≤1232 字节限制），批量间串行发送并逐笔报告结果
- F4.3 **混合 token 转账**：一笔交易内包含多个不同 mint 的转账指令（SOL+SPL+Token2022 混合）
- F4.4 **CPI 批量转账**：仓库提供一个最小示例链上程序（Anchor 或 pinocchio），该程序接收一个指令后通过 CPI 循环完成多笔 Token 转账；工具负责部署该程序（本地net/testnet）并构造调用。用于测试 CPI 场景
- F4.5 转账前 dry-run（simulateTransaction）可选开关；转账回执含签名、slot、费用、错误详情
- F4.6 ATA（关联代币账户）自动创建：接收方无账户时可自动创建并计费，可在指令中关闭此行为

### F5 代币发行（Token Creation）

- F5.1 创建标准 SPL Token mint（可配置 decimals、mint authority、freeze authority）
- F5.2 创建 Token2022 mint，创建时可选启用以下扩展（Extensions）：
  - Transfer Fee Config（转账手续费：费率上限 + 最大费额，可配置）
  - Transfer Hook（转账钩子）
  - Interest Bearing（生息）
  - Non-Transferable（不可转让）
  - Permanent Delegate（永久代理）
  - Metadata Pointer + Token Metadata（链上元数据）
  - Default Account State（默认冻结）
- F5.3 **Token2022 插件运行时管理**（对已存在的 mint）：
  - 更新 Transfer Fee（费率/最大费额，按 epoch 生效）
  - 冻结/解冻指定账户（暂停转账的常用手段）
  - 更新 mint authority / freeze authority
  - 更新元数据字段
- F5.4 Mint / Burn（铸造与销毁代币）

### F6 多签（Multisig）

- F6.1 创建 M-of-N 多签钱包（基于 Squads V4 程序，devnet/testnet/mainnet 均已部署）
- F6.2 多签成员管理：添加/移除成员、修改阈值
- F6.3 多签提案流程：创建提案（转账 SPL/SOL/Token2022）→ 成员审批 → 达到阈值后执行
- F6.4 提案状态查询：列出待审批/已执行/已拒绝提案
- F6.5 UI 与 MCP 均暴露完整多签流程

### F7 Web UI

- F7.1 单页应用（React + Vite），左侧网络与钱包管理，右侧功能操作区
- F7.2 页面/模块：Dashboard（网络状态+余额）、钱包（生成/导入/导出）、转账（普通/批量/混合/CPI）、代币发行（SPL/Token2022 + 插件管理）、多签
- F7.3 交易历史列表（本地存储），含签名、状态、费用，可跳转 Explorer
- F7.4 密钥仅在浏览器内存/本地存储，不经过任何服务器（纯前端 + 直接 RPC）；导出操作需二次确认
- F7.5 视觉风格：深色主题为主，技术感，关键操作（转账/导出）有醒目风险提示

## 4. 技术架构

```
solana-wallet/
├── packages/
│   ├── core/        # 核心库：连接、钱包、转账、发币、多签（零 UI 依赖）
│   ├── mcp/         # MCP Server：工具定义 → 调用 core
│   └── cpi-program/ # 示例 CPI 程序（Anchor）
├── apps/
│   └── web/         # Web UI（React + Vite + Tailwind）
├── skills/
│   └── solana-wallet/SKILL.md
└── .taskmaster/
```

- 语言/运行时：TypeScript ≥5.5，Node ≥20
- 链上库：`@solana/web3.js` 1.x + `@solana/spl-token`（含 Token2022 扩展支持）+ `@sqds/multisig`
- 包管理：pnpm workspace
- MCP SDK：`@modelcontextprotocol/sdk`
- 测试：Vitest，core 层核心逻辑需单元测试；链上集成测试标记为可选（需要网络）

## 5. 非功能性需求

- 密钥文件与助记词永不打印到日志；MCP 输出中密钥内容默认脱敏（仅显示地址）
- 所有金额使用最小单位（lamports / token base units）内部计算，展示层做精度换算
- 错误信息包含：程序错误码解析（如 insufficient funds、账户不存在）+ 建议动作
- 每个 MCP 工具必须有清晰的 inputSchema 描述，让 AI 能零文档正确调用

## 6. 验收标准（MVP）

1. 用户 clone 仓库后，按 README 在 Claude Code 中添加 MCP，能用自然语言完成：生成钱包 → airdrop → 创建 Token2022（带 Transfer Fee）→ 批量转账 → 查询余额，全程无需手写代码
2. Web UI 能独立完成上述同样流程
3. 多签：3 人 2 签场景下完成一笔 SPL 转账提案的创建、审批、执行
4. `pnpm test` 全绿；core 层单元测试覆盖钱包、金额换算、批量分片逻辑
