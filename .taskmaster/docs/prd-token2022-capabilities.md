# PRD 增补：Token-2022 开发者能力（观察 · 构造 · 解析）

> 本 PRD 为既有 solana-wallet（任务 1~14 已完成）的增量需求。目标：把钱包从"能发一笔"升级为"按开发者指定方式构造、预检、发送并解析"的开发者钱包，使第三方团队能基于我们的 core / MCP / Skill / Web 组合出自己的 Token-2022 接入测试。我们提供**原语 + 可观测性**，不内置任何第三方的断言矩阵、业务错误码或报告格式。

## 设计原则

1. 所有新能力先落在 `packages/core`（纯函数优先、零 UI 依赖），再暴露为 MCP 工具，再写进 SKILL.md，最后视情况加 Web 页面。
2. 默认行为保持现在的安全策略（devnet 默认、mainnet 发送阻断、transferChecked、幂等建 ATA）。所有"非标准"构造方式必须显式传参开启。
3. 金额一律 base units（raw amount）。`uiAmount` 只允许出现在 Web 显示层，不得出现在 core 计算、MCP 输出字段中。
4. 输出结构化、可机读：每个带 signature 的结果附 `explorerUrl`；错误带稳定 `code`。
5. 离线可测：解析、解码、推导、构造计划等纯函数部分用 fixture JSON 做单元测试，不依赖网络。

## 第一期：观察与构造

### T-A 地址与账户观察（core + MCP）

- `deriveTokenAddresses({ owner, mint })`：同时返回 legacy 与 Token-2022 两个 ATA，每个附 `programId`、`isOffCurve`（应恒为 true）。owner 若为 off-curve 地址（PDA）则默认拒绝，`allowOwnerOffCurve: true` 才放行。两个 ATA 必须不同，测试中固定已知向量（owner/mint → ATA）做回归。
- `inspectMint(conn, mint)`：返回 `program`（spl-token / token-2022）、`decimals`、`supply`、`mintAuthority`、`freezeAuthority`、`extensions[]`（每项含类型与解码后的参数：TransferFeeConfig 的 older/newer 两档 bps 与 maxFee 及 withheld；PermanentDelegate 地址；TransferHook programId；ScaledUiAmount multiplier；MetadataPointer / TokenMetadata；InterestBearing rate；DefaultAccountState；NonTransferable；ConfidentialTransfer 仅识别），以及 `accountLen`（用 `getAccountLen` 按 mint 扩展推算 ATA 应有长度）。
- `inspectTokenAccount(conn, address)`：owner、mint、amount(raw)、delegate、state、账户级扩展（MemoTransfer 是否开启、ImmutableOwner、CpiGuard、TransferFeeAmount withheld），`dataLength`。
- MCP 新工具：`derive_address`、`inspect_mint`、`inspect_token_account`。`get_balances` 输出去掉 `uiAmount` 字段（core 的 `TokenBalance.uiAmount` 改为可选且 MCP 层剔除）。
- `shortAddress` 默认改为前 6 位 + 后 4 位。

### T-B 交易计划与构造旋钮（core + MCP）

- 新类型 `TransactionPlan`：`instructions[]`（每条含 `programId`、`accounts[{pubkey,isSigner,isWritable}]`、`dataHex`、`label`），`messageHex`（`message.serialize()` hex）、`estimatedBytes`、`signers[]`、`blockhash`。
- `buildTransferPlan(conn, opts)` 扩展现有 `buildTransferInstructions`，新增旋钮（均可选，默认保持现状）：
  - `computeBudget?: { unitLimit?: number; unitPrice?: number }` → 置顶加入 `setComputeUnitLimit` / `setComputeUnitPrice`。
  - `ataMode?: "auto" | "always-idempotent" | "create" | "none"`。auto = 现状（缺失才加幂等指令）；always-idempotent = 恒加；create = 非幂等 `Create`；none = 不加。
  - `instruction?: "transferChecked" | "transfer" | "transferCheckedWithFee"`，`transferCheckedWithFee` 需传 `fee`。
  - `authority?: PublicKey`，可与 owner 不同（PermanentDelegate / delegate 划转），此时 `sourceOwner` 需显式传。
  - `memo?: string` → 附加 Memo 程序指令（放在 transfer 之前）。
- `transfer()` 接受同样的旋钮，并在结果中返回 `plan`。
- MCP 新工具 `build_transfer`（只构造不发送，返回 TransactionPlan）；现有 `transfer` 工具加同名可选参数。

### T-C 预检与强制发送（core + MCP）

- `preflightTransfer(conn, plan 或 opts)` 返回 `{ ok, findings[] }`，每条 finding 含 `code`、`severity`（block / warn / info）、`message`、`data`。检测项：
  - `TRANSFER_HOOK_PRESENT`（mint 带 TransferHook 且 programId 非空）→ block
  - `MEMO_REQUIRED`（收款 ATA 已开启 MemoTransfer 且计划无 Memo）→ block
  - `DEST_ATA_MISSING` → info
  - `TRANSFER_FEE`（bps、maxFee、按当前 epoch 取档、预计扣费与净额）→ info
  - `ACCOUNT_FROZEN`、`NON_TRANSFERABLE` → block
  - `SCALED_UI_AMOUNT`（提示 raw amount 不换算）→ warn
- `transfer()` 默认先 preflight，block 级 finding 阻断并返回 `error.code = PREFLIGHT_BLOCKED` 及 findings；`force: true` 跳过阻断直发，让链上 preflight 兜底。
- MCP：`preflight_transfer` 工具；`transfer` 加 `force` 参数。

### T-D 原始交易通道（core + MCP）

- `signTransactionHex(keypair, txHex)`：对序列化交易做部分签名，返回新的 tx hex 与 signature hex。
- `simulateRaw(conn, txHex)`、`sendRaw(conn, txHex, { allowMainnet, force })`。
- MCP：`sign_transaction`、`simulate_transaction`、`send_transaction`。用途：外部服务构造 payload → 我们签 → 外部提交，或反之。

### T-E 交易解析与错误解码（core + MCP）

- `inspectTransaction(input)`：`input` 为 signature（需 conn，内部 `getParsedTransaction` + `maxSupportedTransactionVersion: 0`）或一份 getTransaction JSON（纯离线）。输出：
  - `signature`、`slot`、`blockTime`、`fee`、`err`（原始）、`explorerUrl`
  - `movements[]`：每条代币流动含 `program`（spl-token / token-2022）、`instructionType`（transfer / transferChecked / transferCheckedWithFee / mintTo / burn / withdrawWithheld / 其它）、`isInner`（CPI 内层）、`sourceAccount`/`sourceOwner`、`destAccount`/`destOwner`、`authority`、`mint`、`amount`（声明）、`fee: { amount, source: "instruction" | "balance-delta" | null }`、`balanceDelta`（按 pre/post token balance 推算的目标账户净入账）。
  - `balanceChanges[]`：所有 token account 的 pre/post raw 差值。
  - `warnings[]`：如 ConfidentialTransfer 指令存在、无法解析的指令。
- `decodeInstructionError(err, message?)`：解析 `InstructionError`，输出 `instructionIndex`、`programId`、`customCode`、`name`（SPL Token / Token-2022 错误枚举名，如 31 = MintMismatch、36 = NoMemo、67 = ... 依官方枚举表）。并入 `parseTransactionError`，使 `ParsedProgramError` 多出 `custom?: { code, name, instructionIndex }`。
- 用 fixture JSON（放 `packages/core/src/inspect/__fixtures__/`）覆盖：transfer、transferChecked、transferCheckedWithFee、CPI 内层、PermanentDelegate 划转、withdrawWithheld、失败交易。fixture 可来自 devnet 真实交易。
- MCP：`inspect_transaction`（参数 signature 或 json）。

## 第二期：扩展补齐

### T-F ScaledUiAmount 与预设层（core + MCP + Web）

- `createToken2022Mint` 新增 `scaledUiAmount: { multiplier }` 扩展；`manage` 新增 `updateScaledUiMultiplier`。
- core 新增 `TOKEN_PRESETS`：`plain-2022`、`transfer-fee`（可配 bps/maxFee，默认 0）、`permanent-delegate`、`scaled-ui`、`transfer-hook`、`legacy-spl`、`memo-required`（建 mint 并给收款方 ATA 开 MemoTransfer 的说明）。每个预设是一组 `CreateMintOptions` 默认值，允许字段覆盖。
- MCP `create_token` 加 `preset` 参数；可选 `mintTo: { owner, amount }` 一步完成建 mint + mint 给指定钱包。
- Web 发币页加"快速模板"下拉。

### T-G 账户级扩展操作（core + MCP）

- `manage_token2022` 新增动作：`enableMemoTransfer` / `disableMemoTransfer`（对自己的 ATA）、`withdrawWithheldFromAccounts`、`harvestWithheldToMint`、`withdrawWithheldFromMint`、`updateTransferHookProgram`。
- `inspectTokenAccount` 对应字段可验证结果。

### T-H 入账侧发送能力（core + MCP）

- 利用 T-B 的 `authority` 与 `instruction` 旋钮，补齐：delegate 划转（先 `approve`）、PermanentDelegate 强制划转、`transferCheckedWithFee`、plain `transfer`。
- MCP `transfer` 新增 `sourceOwner` + `authority` 语义；新增 `approve_delegate` / `revoke_delegate`。

## 第三期：深水区

### T-I 代币 CPI 转发程序

- `packages/cpi-program` 新增 `forward_transfer_checked` 指令：程序作为中转，通过 CPI 调用 Token / Token-2022 的 transferChecked（source authority 为调用者签名）。
- core `cpi.ts` 新增 `cpiTokenTransfer`，MCP 新增 `cpi_token_transfer`。目的：让"内层转账"能在链上被制造出来以便解析测试。

### T-J Web：交易查看器与构造预览

- 转账页："高级构造"折叠区（computeBudget / ataMode / instruction / memo / force），"预览"面板展示指令列表与 message hex、预检结果。
- 新页面"交易查看器"：输入 signature，展示 `inspectTransaction` 结果与 explorer 链接，支持导出 JSON。
- 代币管理页展示 `inspectMint` 扩展详情。

### T-K Skill 范式与示例

- SKILL.md 增加"组合示例"章节：建 mint → build_transfer → preflight → transfer → inspect_transaction 的完整链路，以及如何用 fixture 离线复现。
- `examples/` 目录放 3 个用 core API 写的脚本（费率 mint 入账净额、Memo 拦截与绕过、PermanentDelegate 划转），输出 JSON。
- README 更新工具总数与能力矩阵。

## 验收

- 单测：T-A/T-B/T-E 纯函数部分全部有离线测试；fixture 覆盖 7 类交易。
- typecheck 与 vitest 三包全绿。
- 本地 validator 端到端：建 transfer-fee mint → `build_transfer` 看到四指令 → `preflight` → 发送 → `inspect_transaction` 得到 amount 与 fee 一致；MemoTransfer 开启后 `transfer` 被 `MEMO_REQUIRED` 阻断、`force` 后链上 `NoMemo`。
- MCP 输出不含 `uiAmount`。
