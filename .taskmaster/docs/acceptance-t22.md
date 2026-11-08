# Token-2022 能力增补（任务 15~25）验收说明

日期：2026-11-07 夜。工作区**未提交**，包含两部分改动：当天更早的全面测试报告修复，以及本次任务 15~25 全部新功能与审查修复。

## 一、验证结果（主会话独立复跑）

| 项目 | 结果 |
|---|---|
| `pnpm typecheck`（core / mcp / web / examples） | 通过 |
| `pnpm test` | 31 文件 / 408 测试通过 |
| `pnpm --filter @solwallet/web build` | 通过 |
| cpi-program mollusk 链上测试 | 9 / 9 通过 |
| 本地 validator 真实链验收 `node packages/mcp/acceptance-t22.mjs` | 11 场景 / 98 检查全部 PASS |
| `examples/*.ts` 三个脚本（本地 validator） | 全部 ok |

验收脚本覆盖：transfer-fee 预设 + inspect_mint/derive_address；四指令标准构造 + 预检 TRANSFER_FEE + inspect_transaction 费用/净额；MemoTransfer 拦截 → force 后链上 NoMemo(36) → 带 memo 成功；withheld 提取；PermanentDelegate 强制划转；approve/revoke delegate 三态；非标准构造（plain transfer → 链上 31，非幂等 create 失败）；raw 签名/模拟/发送；scaled-ui 与 legacy-spl；代币 CPI 内层转账。

## 二、代码审查与修复

审查（high 级别）给出 8 条发现，加上真实链验收发现 1 条 bug，全部已修并补测试：

1. 非 Token 程序的 custom 错误被错误命名为 `TOKEN_<Name>` → 只有确认是 Token/Token-2022 程序（从日志 `Program <id> failed` 或调用方提示解析）才命名，否则 `PROGRAM_ERROR`，`custom.programId` 可为 null。
2. 确认阶段用新取的 `lastValidBlockHeight` 配旧 blockhash，过期永远检测不到 → `sendWithRetry` 新增 `lastValidBlockHeight` 选项并从所有构造点透传；缺省时改为轮询 `getSignatureStatuses` + `isBlockhashValid`，能返回 `BLOCKHASH_EXPIRED`。
3. `deployCpiProgram` 用静态 cluster 判断主网且不透传 `allowMainnet` → 改用 `isMainnet()` 并逐笔透传。
4. `FEE_MISMATCH` 从 warn 升为 block（链上必拒）。
5. 新增 block 码 `UNCHECKED_TRANSFER_REJECTED`：Token-2022 带 TransferFee/TransferHook 的 mint 用 plain `transfer` 必然 custom 31。
6. `destinationAtaCreated` 在 always-idempotent/create 模式下误报 → 仍查一次账户存在性，新增 `destinationAtaExisted` 字段。
7. `transfer()` 预检与构造重复拉取同三个账户 → 预检结果透传给构造器，一次 token 转账固定 3 次账户读取 + 1 次 blockhash。
8. MCP `transfer` 自己复制了一套发送流程 → 改为直接调用 core `transfer()`，输出形状不变。
9. （验收发现）MCP 错误 catch 丢掉 `custom` 码，force 后看不到 NoMemo/MintRequiredForTransfer → `run()` 现在透传完整 `ParsedProgramError`；`SIMULATION_FAILED` 消息附带失败程序的日志行。

## 三、请你明天决定的事

1. **提交方式**：建议分两次提交，先提交测试报告修复，再提交任务 15~25。或者一次提交也可以。
2. **Web 语言**：新面板（高级构造、预览、交易查看器、mint 详情、地址工具）用了中文标签，旧页面是英文。统一成哪种。
3. **金额单位约定**：`transfer.amount` 与 `approve_delegate.amount` 是人类可读单位，`create_token.mintTo.amount`、`fee`、`manage_token2022` 的金额是 base units。SKILL.md 已注明，但如果想统一可以再改。

## 四、已知限制（已记录在 SKILL/README 或代码注释）

- Web 只能用当前钱包签名，authority 与 payer 不同的发送请走 MCP 或 examples。
- transfer-hook 预设的 programId 是零地址占位，真实 hook 程序需自行提供。
- `raw.ts` 的 `sendRaw` 不知道 `lastValidBlockHeight`，走轮询确认。
- cpi-program 的 `.so` 不入库，需 `cargo build-sbf` 生成；mollusk 测试需 `SBF_OUT_DIR` 与本机工具链覆盖变量（见 packages/cpi-program/README.md）。
- 新建的 `packages/mcp/acceptance-t22.mjs` 依赖本地 validator 和已部署的 CPI 程序，不进 CI。

## 五、快速验收命令

```bash
pnpm --filter @solwallet/core build && pnpm --filter @solwallet/mcp build
pnpm typecheck && pnpm test && pnpm --filter @solwallet/web build
# 需本地 validator（127.0.0.1:8899）
node packages/mcp/acceptance-t22.mjs
```
