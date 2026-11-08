# skills/solana-wallet

Claude Skill 定义目录。`SKILL.md` 是给 AI 的使用手册：何时调用 solwallet MCP server 的 29 个工具、参数约定、标准工作流剧本、「组合示例」（观察 → 构造 → 预检 → 发送 → 解析）、预检代码参考与错误自纠错规则。

工具分组（与 `packages/mcp/src/tools/*.ts` 一一对应）：

| 分组 | 工具 |
|---|---|
| 钱包 | `create_wallet` `import_wallet` `list_wallets` `export_secret` |
| 集群 | `get_cluster_status` `request_airdrop` `get_balances` |
| 发送 | `transfer` `batch_transfer` `mixed_transfer` |
| 观察 | `derive_address` `inspect_mint` `inspect_token_account` |
| 构造 / 预检 | `build_transfer` `preflight_transfer` |
| 原始交易 | `sign_transaction` `simulate_transaction` `send_transaction` |
| 解析 | `inspect_transaction` |
| 委托 | `approve_delegate` `revoke_delegate` |
| CPI | `cpi_token_transfer` |
| 代币 | `create_token`（7 个预设）`manage_token2022`（15 个动作） |
| 多签 | `create_multisig` `propose_multisig` `approve_multisig` `execute_multisig` `get_multisig` |

金额约定：所有工具的金额输入都是 base units 整数字符串（lamports / 代币最小单位，1 SOL = `"1000000000"`），输出保留 raw 值并附 `*Display` 可读提示；代币工具的 `decimals` 可省（自动从 mint 读）。详见 `SKILL.md`「金额单位：只有一条规则」。

同一链路的纯 core 脚本版本见仓库根目录 `examples/`。
