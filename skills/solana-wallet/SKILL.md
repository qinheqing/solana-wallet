---
name: solana-wallet
description: Solana 钱包与转账测试工具集（solwallet MCP server）。当用户提到 Solana 测试、devnet / testnet / localnet 操作、生成或导入测试钱包、领测试 SOL（airdrop / 水龙头）、SOL / SPL / Token-2022 转账测试、批量转账或空投模拟、混合多币转账、查钱包余额、交易 dry-run 模拟、创建代币 / Token-2022 扩展与运行时管理（铸造、销毁、费率、冻结、权限、元数据、MemoTransfer、费用提取）、代币预设模板、转账预检（transfer hook / memo / 冻结 / 费率）、只构造不发送（指令列表、message hex）、离线签名 / 模拟 / 发送外部交易、解析交易（代币流动、手续费、链上错误枚举名）、ATA 推导、mint / 代币账户观察、委托与 PermanentDelegate 划转、经 CPI 转发程序制造内层转账、Squads 多签（创建 / 提案 / 批准 / 执行）时使用。通过 29 个 MCP 工具执行，本 Skill 提供工具选择决策、参数约定、标准工作流、组合示例与错误自纠错规则。
---

# solana-wallet 使用手册

给 AI 的操作规范。所有操作通过 solwallet MCP server 的工具完成；服务器默认连 devnet（`SOLWALLET_CLUSTER` 可改）。密钥只存在于服务器进程内存，重启即清空——这是测试工具，不是主网钱包。

## 能力总览（29 个工具）

| 分组 | 工具 | 一句话 |
|---|---|---|
| 钱包（4） | `create_wallet` `import_wallet` `list_wallets` `export_secret` | 内存钱包的生命周期 |
| 集群（3） | `get_cluster_status` `request_airdrop` `get_balances` | 健康、水龙头（`lamports`）、余额（raw `solLamports` / `amount` + `solDisplay` / `display` 提示，没有 `uiAmount`） |
| 发送（3） | `transfer` `batch_transfer` `mixed_transfer` | 真正上链的转账；`transfer` 自带预检与全部构造旋钮 |
| 观察（3） | `derive_address` `inspect_mint` `inspect_token_account` | 只读：ATA 推导（离线）、mint 扩展解码、代币账户扩展解码 |
| 构造（1） | `build_transfer` | 只构造不签不发：指令列表 + message hex + signers |
| 预检（1） | `preflight_transfer` | 发送前读链判定 block / warn / info，见下文代码表 |
| 原始交易（3） | `sign_transaction` `simulate_transaction` `send_transaction` | 对 hex / base64 序列化交易做部分签名、模拟、发送 |
| 解析（1） | `inspect_transaction` | 签名或 getTransaction JSON → 代币流动、手续费、余额差、错误枚举名 |
| 委托（2） | `approve_delegate` `revoke_delegate` | 普通 delegate 的授权 / 撤销；划转本身走 `transfer` |
| CPI（1） | `cpi_token_transfer` | 经 `solwallet_cpi` 转发程序发 transferChecked，让代币流动成为**内层指令**（`inspect_transaction` 的 `isInner: true`）；程序需已部署 |
| 代币（2） | `create_token` `manage_token2022` | 建 mint（7 个预设 + `mintTo`）、15 个运行时动作 |
| 多签（5） | `create_multisig` `propose_multisig` `approve_multisig` `execute_multisig` `get_multisig` | Squads V4 |

预设（`create_token.preset`）：`plain-2022` / `transfer-fee` / `permanent-delegate` / `scaled-ui` / `transfer-hook` / `legacy-spl` / `memo-required`。预设只是默认值，显式字段覆盖。

## 工具决策表

| 用户意图 | 工具 | 关键点 |
|---|---|---|
| 新建测试钱包 | `create_wallet` | 默认 12 词助记词；`strength: 256` 为 24 词；助记词不回显；同名已存在会报错，确认要替换才传 `overwrite: true` |
| 用已有钱包（keyfile / 助记词） | `import_wallet` | `keyfileJson` 与 `mnemonic` 二选一，不能都传或都不传；同名保护同上 |
| 看当前加载了哪些钱包 | `list_wallets` | 无参数，随时可调 |
| 备份 / 导出密钥 | `export_secret` | 仅用户明确要求时；`format: "keyfileJson"` 或 `"mnemonic"` + `dangerouslyAllowSecretExport: true` |
| 集群健康（slot / 版本 / TPS） | `get_cluster_status` | 排查连接问题的第一步 |
| 领测试 SOL | `request_airdrop` | `lamports` 传 base units（1 SOL = `"1000000000"`）；mainnet-beta 直接拒绝；公共水龙头 410 见下文 |
| 查余额（SOL + 全部代币） | `get_balances` | 含 SPL 与 Token-2022 账户；`solLamports` / 代币 `amount` 是 raw base units，旁边 `solDisplay` / `display` 是可读提示 |
| 单笔转账 | `transfer` | `amount` 是 base units；代币转账传 `mint`（`decimals` 可省，自动从 mint 读）；默认先预检，block 级发现返回 `PREFLIGHT_BLOCKED` |
| 一对多批量 | `batch_transfer` | 1–50 接收者，自动分块串行 |
| 多资产打包一笔 | `mixed_transfer` | 2–10 条腿，共享一个签名 |
| 发送前验证 | 任何发送工具 + `dryRun: true` | 只模拟，返回日志 |
| 发送前**读链判定**（不构造不签） | `preflight_transfer` | 返回 `findings[]`；比 dryRun 更早、更便宜，且能说出"为什么" |
| 只看会发出什么 / 把 payload 交给外部签 | `build_transfer` | 返回 `plan.instructions[]`（label / programId / accounts / dataHex）、`plan.messageHex`、`plan.signers` |
| 外部构造好的交易要我签 / 模拟 / 发 | `sign_transaction` → `simulate_transaction` → `send_transaction` | 输入 hex 或 base64；`send_transaction` 拒绝未签满（`TX_NOT_FULLY_SIGNED`） |
| 算某个钱包在某 mint 下的 ATA | `derive_address` | 离线；同时给 legacy 与 Token-2022 两个地址，二者必不同 |
| 看 mint 有哪些扩展 / 费率 / 权限 | `inspect_mint` | `extensions[]` 已解码；`accountLen` 是该 mint 的 ATA 应有长度 |
| 看某个代币账户状态 / 是否要求 memo / 扣留费 | `inspect_token_account` | 传 ATA 地址（不是钱包地址，先 `derive_address`） |
| 解析一笔交易到底转了多少、扣了多少、为什么失败 | `inspect_transaction` | `signature`（在线）或 `json`（离线，粘 getTransaction 结果） |
| 创建代币（SPL 或 Token-2022） | `create_token` | 给 `preset` 可省 `decimals`；`mintTo` 一步铸给指定钱包；返回 `mint` |
| 铸造 / 销毁代币 | `manage_token2022` + `action: "mintTokens"` / `"burnTokens"` | SPL 与 Token-2022 通用；`params.amount` 和所有金额一样是 base units 整数串 |
| 改费率 / 冻结解冻 / 换权限 / 改元数据 / 改显示倍率 / 改 hook 程序 | `manage_token2022` + 对应 `action` | 仅 Token-2022 mint；调用方钱包必须是对应 authority |
| 让自己的收款账户强制要 memo | `manage_token2022` + `enableMemoTransfer` / `disableMemoTransfer` | 作用于**调用钱包自己的 ATA**（必要时自动创建并 realloc） |
| 收转账费 | `manage_token2022` + `withdrawWithheldFromAccounts` / `harvestWithheldToMint` / `withdrawWithheldFromMint` | `sources` 传代币**账户**地址，不是钱包地址 |
| 授权别人替我转 / 撤销 | `approve_delegate` / `revoke_delegate` | 之后 delegate 用 `transfer` + `sourceOwner` 划转 |
| 替别人转（delegate / PermanentDelegate） | `transfer` + `walletName=<delegate>` + `sourceOwner=<owner>` | owner 不签名；PermanentDelegate 无需事先 approve |
| 制造一笔"CPI 内层"代币转账（测解析器） | `cpi_token_transfer` | `programId` 必传（已部署的 `solwallet_cpi`）；`amount` 是 base units，`decimals` 可省；钱包自己是源 authority，无 PDA 托管 |
| 创建多签 | `create_multisig` | 记下返回的 `multisigPda`（后续工具要用）与 `vaultPda`（先给它打 SOL） |
| 多签发起转账 | `propose_multisig` | 从金库转出 SOL / 代币；记下 `transactionIndex` |
| 多签投票 | `approve_multisig` | 每个成员各用自己的 `walletName` 调一次；达阈值后 `executeReady: true` |
| 多签执行 | `execute_multisig` | 只有状态为 approved 的提案能执行 |
| 看多签状态 / 提案列表 | `get_multisig` | 只读，无需签名钱包 |

转账层（`transfer` / `batch_transfer` / `mixed_transfer`）已自动识别 mint 属于 SPL Token 还是 Token-2022，无需指定程序。

## 参数约定

- **所有金额都是 base units 整数字符串**（和区块浏览器一致），见下文「金额单位：只有一条规则」。不要传 `"1.5"` 这种人类可读数，不要用科学计数法，不要传数字类型——schema 直接拒绝并提示 base units。
- **输出里的金额同样是 raw base units 字符串**（`amount`、`amountBaseUnits`、`solLamports`、`feeLamports`、`balanceDelta`、`fee.amount`、`supply`、`withheldAmount`、`expectedFee`、`net`……），**永远不含 `uiAmount`**。较大的金额旁边会多一个 `*Display` 字段给人看（`amountDisplay`、`solDisplay`、`feeDisplay`、`expectedFeeDisplay`、`netDisplay`、`supplyDisplay`、`balanceDeltaDisplay`、余额里的 `display`），形如 `"1.5 SOL"` / `"0.25 (6 dp)"`。`*Display` 只用于复述给用户，**不要把它回传给任何工具**；ScaledUiAmount 的倍率不会被套用。
- **`overwrite`**（`create_wallet` / `import_wallet`）：默认 `false`，同名钱包已加载时报 `INVALID_INPUT`（"already exists"）。不要自动加 `overwrite: true` 绕过——旧密钥会被丢弃，先问用户是换个名字还是确认替换。
- **decimals 可选，且只对代币有意义**：带 `mint` 的工具（`transfer` / `build_transfer` / `preflight_transfer` / `batch_transfer` / `mixed_transfer` 的 token 腿 / `approve_delegate` / `propose_multisig` / `cpi_token_transfer`）省略 `decimals` 时会自动从 mint 读取（多一次 RPC 读）；传了就直接用（省一次读，但传错会在链上被 transferChecked 拒绝，不会被纠正）。`decimals` **不参与金额换算**——金额永远是 base units。SOL 操作传 `decimals` 会直接报错。
- **`walletName` vs `address`**：操作已加载的钱包用 `walletName`；操作外部地址（如给任意地址查余额、空投）用 `address`。二者提供其一。
- **`cluster`**：可选，接受官方名（`devnet` / `testnet` / `mainnet-beta`）或**完整 RPC URL**（含 `http://127.0.0.1:8899`）。省略时用服务器默认。临时换集群不需要用户改配置，直接在调用里传 URL。
- **`allowAtaCreation`**（仅 `ataMode: "auto"` 时有意义）：默认 `true`，接收方无代币账户时自动创建（约 0.002 SOL 租金，由发送方支付）。接收方是程序派生地址等特殊场景才需要关掉。
- **`dryRun: true`**：金额大、接收者多、指令复杂时先模拟一次，看 `logs` 里有没有报错再真发。
- **`allowMainnet: true`**（字面量）：mainnet-beta 上所有发送类工具的硬性确认。真实资金。**必须先向用户复述金额、接收地址并得到确认，才能传这个参数。**
- **`dangerouslyAllowSecretExport: true`**（字面量）：导出密钥的唯一逃生口。仅当用户明确要求备份或导出时使用；导出后提醒用户安全保存。

### 构造旋钮（`transfer` / `build_transfer` / `preflight_transfer` 共用）

全部可选，省略即今天的标准行为。非默认值会**故意**产出非标准交易，用于测试第三方接入；预检会以 `NON_STANDARD_CONSTRUCTION`（info）提示。

| 参数 | 默认 | 作用 |
|---|---|---|
| `computeUnitLimit` / `computeUnitPrice` | 不加 | 置顶插入 `setComputeUnitLimit` / `setComputeUnitPrice`（price 单位 microLamports/CU） |
| `ataMode` | `auto` | `auto` 缺 ATA 才加幂等创建；`always-idempotent` 恒加幂等创建；`create` 加非幂等 Create（ATA 已存在则链上失败）；`none` 不加也不报 `ATA_MISSING`。结果里 `destinationAtaCreated` 表示本笔**真的会**创建（账户原本不存在且带创建指令），`destinationAtaExisted` 表示构造时账户是否已存在（`none` 不查链则为 `null`） |
| `instruction` | `transferChecked` | `transfer` = 旧式不校验（Token-2022 mint 带 TransferFeeConfig / TransferHook 时链上必败 custom 31，预检 `UNCHECKED_TRANSFER_REJECTED` 拦截）；`transferCheckedWithFee` = Token-2022 费率专用，必须同时传 `fee` |
| `fee` | — | base units 整数串（和所有金额一样），必须等于 mint 当前档位算出的费，否则链上 `FeeMismatch`（预检 `FEE_MISMATCH` 直接拦截，`force` 可越过） |
| `memo` | — | 在转账指令前插一条 Memo 程序指令；MemoTransfer 收款账户必需 |
| `sourceOwner` | `walletName` 地址 | 源 ATA 的 owner 不是调用钱包时传（delegate / PermanentDelegate 划转） |
| `authorityWallet`（仅 `transfer`） / `authority`（`build` / `preflight`） | `walletName` | 签 transfer 指令的权限方不是付费钱包时传；`transfer` 需要那个钱包已加载并会被要求共同签名 |
| `force`（仅 `transfer`） | `false` | 跳过 block 级预检直接发，让 validator 预检兜底；findings 仍随结果返回 |
| `skipPreflight`（仅 `transfer`） | `false` | 完全不做本地预检（少几次 RPC 读），结果里没有 `preflight` |

## 金额单位：只有一条规则（base units）

**所有工具的所有金额输入都是 base units 整数字符串**——lamports 或代币最小单位，不含小数点，和区块浏览器显示的 raw 值一致。没有例外，不存在"人类可读"的字段。

| 资产 | 换算 | 例子 |
|---|---|---|
| SOL | `lamports = SOL × 10^9` | 1 SOL → `"1000000000"`；0.5 SOL → `"500000000"`；0.01 SOL → `"10000000"` |
| 代币 | `base units = 数量 × 10^decimals` | decimals = 6 时 1.5 个 → `"1500000"`；0.01 个 → `"10000"`；decimals = 9 时 2 个 → `"2000000000"` |

适用字段：`transfer.amount`、`build_transfer.amount`、`preflight_transfer.amount`、`batch_transfer.recipients[].amount`、`mixed_transfer.legs[].amount`（sol 腿是 lamports）、`approve_delegate.amount`、`propose_multisig.amount`、`cpi_token_transfer.amount`、`request_airdrop.lamports`、`create_token.mintTo.amount`、`create_token.extensions.transferFeeConfig.maximumFee`、`manage_token2022.params.amount` / `params.maximumFee`、`fee`。

传 `"1.5"`、`"-5"`、`"1e9"` 一律被 schema 拒绝（错误文本带 "base units" 和换算示例）；`"0"` 过 schema 但报 `INVALID_INPUT`（必须 > 0）。不知道 decimals 时用 `inspect_mint`（返回 `decimals` 与 `supplyDisplay`）或 `get_balances` 里的代币条目；用户说"转 1.5 个"时，先查 decimals 再算 base units，复述时用返回里的 `*Display`。

输出约定：原始字段保持 raw（`amountBaseUnits`、`solLamports`、`feeLamports`、`amount`……），旁边多一个同名 `*Display`：

| 工具 | raw 字段 | 提示字段 |
|---|---|---|
| `transfer` / `build_transfer` / `preflight_transfer` / `cpi_token_transfer` / `approve_delegate` / `propose_multisig` | `amountBaseUnits`、`feeLamports`、`decimals` | `amountDisplay`、`feeDisplay` |
| `preflight_transfer` 的 `TRANSFER_FEE` / `FEE_MISMATCH` finding | `data.amount` / `expectedFee` / `net` | `data.amountDisplay` / `expectedFeeDisplay` / `netDisplay` |
| `batch_transfer` | `chunks[].results[].amount`、`chunks[].feeLamports` | `amountDisplay`、`feeDisplay` |
| `mixed_transfer` | `legs[].amount`（= `amountBaseUnits`） | `legs[].amountDisplay` |
| `request_airdrop` | `lamports` | `solDisplay` |
| `get_balances` | `solLamports`、`tokens[].amount` | `solDisplay`、`tokens[].display` |
| `inspect_mint` / `inspect_token_account` | `supply` / `amount`、`delegatedAmount` | `supplyDisplay` / `amountDisplay`、`delegatedAmountDisplay` |
| `inspect_transaction` | `fee`、`movements[].amount` / `fee.amount` / `balanceDelta`、`balanceChanges[].delta`、`solMovements[].lamports`、`solBalanceChanges[].delta` | `feeDisplay`、`amountDisplay` / `feeDisplay` / `balanceDeltaDisplay`、`deltaDisplay`、`lamportsDisplay`、`deltaDisplay` |
| `create_token` / `manage_token2022`（mint / burn） | `mintTo.amount` / `amount`、`feeLamports` | `amountDisplay`、`feeDisplay` |

小数值（computeUnitPrice、以 base units 计的 `fee` 输入等）没有提示字段，raw 数字本身就够读。

## 预检代码参考（`preflight_transfer` / `transfer.preflight`）

`findings[]` 每条含 `code`、`severity`、`message`、`data`。有任一 `block` 则 `ok: false`；`transfer` 遇 block 返回 `error.code = "PREFLIGHT_BLOCKED"`（`force: true` 可越过）。SOL 转账永远 `ok: true, findings: []`。

| code | 级别 | 含义 | 怎么消除 |
|---|---|---|---|
| `TRANSFER_HOOK_PRESENT` | block | mint 带 TransferHook 且程序非空；普通 transferChecked 缺 hook 附加账户 | 本工具不解析 hook 附加账户：用 `updateTransferHookProgram` 置 `null`，或换无 hook 的 mint |
| `MEMO_REQUIRED` | block | 收款 ATA 开了 MemoTransfer 而本次没带 memo | 传 `memo: "..."`；或收款方 `disableMemoTransfer` |
| `ACCOUNT_FROZEN` | block | 源 / 目标 ATA 被冻结，或 mint `DefaultAccountState=frozen` 导致新建的目标 ATA 天生冻结 | freeze authority 执行 `thawAccount`（新账户：先建再解冻） |
| `NON_TRANSFERABLE` | block | mint 不可转让（soulbound） | 无解；只能 mint / burn |
| `SOURCE_ATA_MISSING` | block | 源 owner 从未持有该代币 | 先 `mintTokens` / 转一笔给它；核对 `sourceOwner` 与 mint |
| `INSUFFICIENT_TOKEN_BALANCE` | block | 源余额 < 金额（`data.balance` 是 raw） | 调低金额或先补币 |
| `INSUFFICIENT_DELEGATED_AMOUNT` | block | delegate 额度 < 金额 | owner 重新 `approve_delegate` 更大额度 |
| `AUTHORITY_NOT_DELEGATE` | block | authority 既不是 owner、也不是账户 delegate、也不是 PermanentDelegate | 换 `authorityWallet` / `sourceOwner`，或先 `approve_delegate` |
| `FEE_MISMATCH` | block | `fee` ≠ 按当前 epoch 档位算出的费；链上必败 `FeeMismatch`（custom 32） | 用 `data.expectedFee` 替换 `fee`；要复现链上错误才 `force: true` |
| `UNCHECKED_TRANSFER_REJECTED` | block | `instruction: "transfer"`（不校验）用在带 TransferFeeConfig / TransferHook 的 Token-2022 mint 上（`data.extension` 指出哪一个）；链上必败 `MintRequiredForTransfer`（custom 31） | 改回 `transferChecked`（或 `transferCheckedWithFee`）；要复现 custom 31 才 `force: true` |
| `SCALED_UI_AMOUNT` | warn | mint 有 ScaledUiAmount；`amount` 是 raw，不会乘倍率 | 确认金额单位无误即可，无需动作 |
| `PREFLIGHT_INCOMPLETE` | warn | mint 或账户存在但无法解码，部分检查跳过 | 可继续发；失败时靠链上错误定位 |
| `DEST_ATA_MISSING` | info | 目标 ATA 不存在；`data.ataMode` 说明会不会自动建 | 默认自动建（付费方出租金）；`ataMode: "none"` 则链上必败 |
| `TRANSFER_FEE` | info | mint 收费：`data` 含 `tier`（older/newer）、`transferFeeBasisPoints`、`maximumFee`、`expectedFee`、`net` | 告诉用户到账 = `net`；需要精确声明时用 `transferCheckedWithFee` + `fee = expectedFee` |
| `PERMANENT_DELEGATE_TRANSFER` | info | authority 是 mint 的 PermanentDelegate，无需 owner 同意 | 提醒用户这是强制划转 |
| `DELEGATE_TRANSFER` | info | authority 是账户的普通 delegate，额度足够 | 无需动作 |
| `NON_STANDARD_CONSTRUCTION` | info | 用了非默认旋钮（`data` 列出哪几个） | 有意为之则忽略 |

## 工作流剧本

### 剧本一：新建钱包 → airdrop → 转账 → 查余额

```
create_wallet   { "name": "alice" }                      → 记下 address
request_airdrop { "walletName": "alice", "lamports": "2000000000" }   → signature（2 SOL）
create_wallet   { "name": "bob" }                        → 记下 address
transfer        { "walletName": "alice", "to": "<bob地址>", "amount": "500000000" }   ← 0.5 SOL，lamports
get_balances    { "walletName": "alice" }
get_balances    { "walletName": "bob" }                  → solLamports "500000000"，solDisplay "0.5 SOL"
```

airdrop 失败（`FAUCET_UNAVAILABLE`）走下文水龙头章节，不要反复重试。

### 剧本二：批量空投（SOL 或同一种代币）

```
batch_transfer {
  "walletName": "alice",
  "recipients": [
    { "to": "<地址1>", "amount": "10000000" },      ← 0.01 SOL
    { "to": "<地址2>", "amount": "20000000" },      ← 0.02 SOL
    { "to": "<地址3>", "amount": "30000000" }       ← 0.03 SOL
  ],
  "dryRun": true          ← 接收者多时先模拟
}
```

- 每个接收者金额独立，都是 base units；代币空投加 `mint`（`decimals` 可省；省略 mint 即 SOL，金额是 lamports）。
- 上限 50 个接收者，更多则分多次调用。
- 默认每 8 条指令打成一笔交易（`chunkSize` 可调 1–10），**串行发送**：某块失败立即停止，后续块标记 skipped——根据返回中各 chunk 的报告修复后，从未完成的接收者继续，不要整批重发。

### 剧本三：混合转账（一笔交易多资产）

```
mixed_transfer {
  "walletName": "alice",
  "legs": [
    { "kind": "sol",   "to": "<地址A>", "amount": "1000000000" },                               ← 1 SOL
    { "kind": "token", "to": "<地址B>", "amount": "50000000", "mint": "<MINT地址>", "decimals": 6 }  ← 50 个（6 位小数）
  ]
}
```

- `sol` 腿金额是 lamports，不带 `mint`/`decimals`；`token` 腿必须带 `mint`（缺了报 `INVALID_INPUT`，消息指明是第几条腿），`decimals` 可省（自动从 mint 读）。
- 2–10 条腿打成一个交易、一个签名；任何一条腿失败则整笔失败（`dryRun` 先验证是明智的）。

### 剧本四：发一个 Token-2022 代币并管理

```
create_token {
  "walletName": "alice", "decimals": 6, "tokenProgram": "token-2022",
  "extensions": {
    "transferFeeConfig": { "transferFeeBasisPoints": 100, "maximumFee": "1000000" },   ← base units
    "tokenMetadata": { "name": "Test Coin", "symbol": "TC", "uri": "" }
  }
}                                                                    → 记下 mint
manage_token2022 { "walletName": "alice", "mint": "<mint>", "action": "mintTokens",
                   "params": { "destinationOwner": "<bob地址>", "amount": "1500000" } }   ← 1.5 个
transfer         { "walletName": "bob", "to": "<carol地址>", "amount": "1000000", "mint": "<mint>" }   ← 1 个；decimals 可省
manage_token2022 { "walletName": "alice", "mint": "<mint>", "action": "freezeAccount",
                   "params": { "tokenAccountOwner": "<carol地址>" } }
```

- 用预设更省事：`create_token { "walletName": "alice", "preset": "transfer-fee", "decimals": 6, "extensions": { "transferFeeConfig": {...} }, "mintTo": { "owner": "<bob地址>", "amount": "1500000" } }` 一次完成建 mint + 铸币，返回里 `mintTo.signature` 是第二笔交易。
- `tokenProgram` 省略即普通 SPL Token（不能带 `extensions`）；`mintTokens` / `burnTokens` 对两种程序都可用，其余 action 仅 Token-2022。
- `setTransferFee` 下个 epoch 才生效（返回里有 `effectiveNote`）；`inspect_mint` 的 `TransferFeeConfig` 同时给 `olderTransferFee` / `newerTransferFee` 两档，预检按当前 epoch 取档。
- `setMintAuthority` / `setFreezeAuthority` 传 `newAuthority: null` 表示永久放弃权限，必须同时传 `confirmRevoke: true`，且要先向用户确认——不可逆。
- `updateMetadata` 的 `params`：`{ "field": "name" | "symbol" | "uri" | "<自定义键>", "value": "..." }`。
- `defaultAccountState: { "accountState": "frozen" }` 的代币，新账户收到代币前要先 `thawAccount`。
- 改完任何扩展都用 `inspect_mint` / `inspect_token_account` 核实，不要靠返回值猜。

### 剧本五：2-of-3 多签转账

```
create_multisig  { "walletName": "alice", "members": ["<alice>", "<bob>", "<carol>"], "threshold": 2 }
                                                     → 记下 multisigPda、vaultPda
transfer         { "walletName": "alice", "to": "<vaultPda>", "amount": "1000000000" }   ← 给金库充 1 SOL
propose_multisig { "walletName": "alice", "multisigPda": "<pda>", "to": "<dave>", "amount": "500000000" }   ← 0.5 SOL
                                                     → 记下 transactionIndex
approve_multisig { "walletName": "alice", "multisigPda": "<pda>", "transactionIndex": <idx> }
approve_multisig { "walletName": "bob",   "multisigPda": "<pda>", "transactionIndex": <idx> }  → executeReady: true
execute_multisig { "walletName": "bob",   "multisigPda": "<pda>", "transactionIndex": <idx> }
get_multisig     { "multisigPda": "<pda>" }                                          → 提案状态 executed
```

- 发起人 / 投票人 / 执行人都必须是 `members` 里的成员，且对应钱包已加载。
- 代币提案加 `mint`（`decimals` 可省），`amount` 换成代币 base units；金库要先持有该代币；接收方 ATA 由金库出钱自动创建。
- 同一成员重复投票是空操作（`alreadyApproved: true`），不算错误。
- `timeLock` > 0 时 approved 后还要等够秒数才能执行。

## 组合示例（观察 → 构造 → 预检 → 发送 → 解析）

这一章是给"替第三方做 Token-2022 接入测试"的完整链路。每一步都写明调哪个工具、传什么、看输出里的哪个字段。以下假设 `alice` 已加载且有 SOL，`bob` / `carol` 已加载（只需地址），集群为本地 validator 或 devnet。

### 示例 A：费率 mint 的入账净额

目标：验证 1% 转账费下，声明金额、扣费、实际到账三者一致。

```
1. create_token {
     "walletName": "alice", "preset": "transfer-fee", "decimals": 6,
     "extensions": { "transferFeeConfig": { "transferFeeBasisPoints": 100, "maximumFee": "1000000" } },
     "mintTo": { "owner": "<alice>", "amount": "10000000" }          ← 铸 10 个给 alice
   }
   看：mint、extensions 含 "transferFeeConfig"、mintTo.signature 非空。

2. build_transfer {
     "walletName": "alice", "to": "<bob>", "amount": "1000000", "mint": "<mint>", "decimals": 6,
     "computeUnitLimit": 200000, "computeUnitPrice": 1, "ataMode": "always-idempotent"
   }
   看：plan.instructions 恰好 4 条，label 依次为
       setComputeUnitLimit → setComputeUnitPrice → createAssociatedTokenAccountIdempotent → transferChecked；
       plan.signers == ["<alice>"]；plan.estimatedBytes < 1232；amountBaseUnits == "1000000"、amountDisplay == "1 (6 dp)"。
       这就是"标准形状"——第三方比对指令顺序 / dataHex 时以此为基准。

3. preflight_transfer { 同上参数 }
   看：ok: true；findings 里有 TRANSFER_FEE(info)：data.expectedFee == "10000"（expectedFeeDisplay "0.01 (6 dp)"）、data.net == "990000"（netDisplay "0.99 (6 dp)"）、
       data.tier 说明取的是 older 还是 newer 档；还有 DEST_ATA_MISSING(info，bob 还没 ATA)
       和 NON_STANDARD_CONSTRUCTION(info，因为 ataMode 非 auto)。

4. transfer { 同上参数 }
   看：signature、feeLamports、destinationAtaCreated: true、plan（与第 2 步一致）、preflight（与第 3 步一致）。

5. inspect_transaction { "signature": "<第 4 步 signature>" }
   看：movements[0]：instructionType "transferChecked"、program "token-2022"、
       amount "1000000"（amountDisplay "1 (6 dp)"）、fee { amount: "10000", source: "balance-delta" }、balanceDelta "990000"（balanceDeltaDisplay "0.99 (6 dp)"）。
       恒等式：amount − fee.amount == balanceDelta。balanceChanges 里 bob 的 ATA delta == "+990000"。
6. （可选）inspect_token_account { "address": "<bob 的 ATA>" }
   看：extensions 含 TransferFeeAmount，withheldAmount == "10000"——费先扣留在收款账户，
       之后 alice 用 manage_token2022 withdrawWithheldFromAccounts { sources: ["<bob ATA>"] } 收走。
```

想让第三方看到"显式声明费用"的形状：第 2–4 步加 `"instruction": "transferCheckedWithFee", "fee": "10000"`，预检报 `FEE_MISMATCH`（block）时把 `fee` 换成 `data.expectedFee`；`inspect_transaction` 的 `fee.source` 会变成 `"instruction"`。

### 示例 B：Memo 拦截与绕过

目标：复现 MemoTransfer 的三种结局——本地预检拦下、强制发送被链上拒、带 memo 成功。

```
1. create_token { "walletName": "alice", "preset": "memo-required", "decimals": 6,
                  "mintTo": { "owner": "<alice>", "amount": "5000000" } }        → mint
   注意：memo-required 预设就是 plain-2022；"要求 memo"是账户级扩展，下一步才开。

2. manage_token2022 { "walletName": "bob", "mint": "<mint>", "action": "enableMemoTransfer" }
   看：tokenAccount（bob 的 ATA，自动创建 + realloc）、signature。bob 要有一点 SOL 付租金。
   核实：inspect_token_account { "address": "<tokenAccount>" } → extensions 含
         { "type": "MemoTransfer", "requireIncomingTransferMemos": true }。

3. transfer { "walletName": "alice", "to": "<bob>", "amount": "1000000", "mint": "<mint>", "decimals": 6 }
   看：isError: true；ok: false；error.code == "PREFLIGHT_BLOCKED"；
       preflight.findings 含 MEMO_REQUIRED(block)；plan 仍在（可以看将要发什么）。
       没有上链，不要去浏览器查。

4. transfer { 同上, "force": true }
   看：isError: true；error.code 通常是 "SIMULATION_FAILED"（validator 自己的预检拒绝）；
       关键是 error.custom == { "code": 36, "name": "NoMemo", ... }——这就是链上 Token-2022 的 NoMemo 枚举。
       preflight 仍然附在结果里（告诉你本地早就知道）。

5. transfer { 同上（不带 force）, "memo": "invoice #42" }
   看：signature；plan.instructions 里 memo 指令紧贴在 transferChecked 之前；preflight.ok == true。

6. inspect_transaction { "signature": "<第 5 步 signature>" }
   看：movements[0].amount == "1000000"、fee == null、balanceDelta == "1000000"。
```

要恢复 bob 的正常收款：`manage_token2022 { "walletName": "bob", "mint", "action": "disableMemoTransfer" }`。

### 示例 C：PermanentDelegate 强制划转（以及普通 delegate 对照）

目标：在没有 owner 签名的情况下把 carol 的币转给 bob，并用解析结果证明"签名方 ≠ 源账户 owner"。

```
1. create_token { "walletName": "alice", "preset": "permanent-delegate", "decimals": 6,
                  "mintTo": { "owner": "<carol>", "amount": "3000000" } }        → mint
   预设把 PermanentDelegate 默认设为付费钱包 alice。核实：
   inspect_mint { "mint": "<mint>" } → extensions 含 { "type": "PermanentDelegate", "delegate": "<alice>" }。

2. preflight_transfer { "walletName": "alice", "sourceOwner": "<carol>", "to": "<bob>",
                        "amount": "1000000", "mint": "<mint>", "decimals": 6 }
   看：ok: true；findings 含 PERMANENT_DELEGATE_TRANSFER(info)，data.authority == "<alice>"、
       data.sourceOwner == "<carol>"；另有 NON_STANDARD_CONSTRUCTION(info，列出 sourceOwner)。

3. transfer { 同上参数 }
   看：signature；plan.signers == ["<alice>"]（carol 不在里面——她根本没签）。

4. inspect_transaction { "signature": "<第 3 步 signature>" }
   看：movements[0].authority == "<alice>" 而 movements[0].sourceOwner == "<carol>"，
       destOwner == "<bob>"，balanceDelta == "1000000"。
       "authority ≠ sourceOwner" 就是强制划转的链上证据。
```

普通 delegate 对照（需要 owner 先授权，且额度受限）：

```
1. create_token { "walletName": "alice", "preset": "plain-2022", "decimals": 6,
                  "mintTo": { "owner": "<carol>", "amount": "3000000" } }        → mint2
2. approve_delegate { "walletName": "carol", "mint": "<mint2>", "delegate": "<alice>", "amount": "500000", "decimals": 6 }   ← 0.5 个
   看：tokenAccount（carol 的 ATA）、signature。
3. preflight_transfer { "walletName": "alice", "sourceOwner": "<carol>", "to": "<bob>", "amount": "1000000", "mint": "<mint2>", "decimals": 6 }
   看：ok: false，INSUFFICIENT_DELEGATED_AMOUNT(block)，data.delegatedAmount == "500000"。
4. transfer { 同上但 "amount": "500000" }  → 成功；preflight 含 DELEGATE_TRANSFER(info)。
5. revoke_delegate { "walletName": "carol", "mint": "<mint2>" }  → 之后同样的 transfer 会被 AUTHORITY_NOT_DELEGATE 拦下。
```

两种划转在 MCP 层写法完全一样（`walletName` = 签名的权限方，`sourceOwner` = 被扣款的 owner）；区别只在预检的 info 码和是否需要 `approve_delegate`。付费方与权限方不是同一个钱包时才需要 `authorityWallet`。

### 示例 D：离线复现（fixture）

没有网络、或者要把一笔历史交易写进回归测试时：

```
1. 拿到 getTransaction(jsonParsed, maxSupportedTransactionVersion: 0) 的原始 JSON（可来自 solana CLI、
   RPC 响应或 packages/core/src/inspect/__fixtures__/ 里的样例），整段作为字符串传入：
   inspect_transaction { "json": "<整段 JSON 文本>" }
   看：与在线模式完全相同的 movements / balanceChanges / decodedError；explorerUrl 按当前 cluster 拼。
   失败交易：decodedError == { instructionIndex, programId, customCode, name }，例如 customCode 31 → "MintMismatch"。
   CPI 内层转账：movements[].isInner == true，instructionIndex 是外层指令序号、innerIndex 是内层位置。
   要在线制造这样一笔：cpi_token_transfer { "walletName": "alice", "programId": "<已部署的 solwallet_cpi>",
   "destination": "<bob>", "mint": "<mint>", "amount": "1000000" } → 再 inspect_transaction 其 signature。

2. 地址与账户长度核对（都不用签名）：
   derive_address { "owner": "<钱包>", "mint": "<mint>" }
   看：legacy.address 与 token2022.address 必不同，两者 isOffCurve 都为 true；
       把 token2022.address 与 inspect_transaction 里的 destAccount 对上，证明收款账户是预期 ATA。
   inspect_mint { "mint": "<mint>" }
   看：accountLen —— 该 mint 的 ATA 应有字节数（带扩展会大于 165）；
       再 inspect_token_account 看 dataLength，二者不等说明账户缺扩展空间（例如还没 realloc 出 MemoTransfer）。
```

### 非标准构造与原始交易通道

- `ataMode: "create"`（目标 ATA 已存在）、`instruction: "transfer"` 配错 decimals、`fee` 填错等，都会**故意**造出会在链上失败的交易，用来测第三方的错误处理。预检只会以 info / warn 提示，`transfer` 会照发；失败后 `error.custom.name`（如 `MintMismatch`、`FeeMismatch`）与 `inspect_transaction.decodedError` 给出枚举名。
- 外部系统构造的 payload：`sign_transaction { "transaction": "<hex 或 base64>", "walletNames": ["alice"] }` → 看 `fullySigned`；为 true 才 `send_transaction`；不确定先 `simulate_transaction` 看 `logs`。钱包不是该交易的必需签名者会报 `SIGNER_NOT_REQUIRED`。
- 反向：`build_transfer` 的 `plan.messageHex` 只是 message，不是完整交易；交给外部签名器时说明这一点。

## 错误处理：先读 `error.suggestion`，不要盲目重试

两种失败形态，都带 `isError: true`：

1. 工具抛错：正文是 `{ "error": { "code", "message", "suggestion" } }`。
2. 工具没抛错但结果表示失败：正文是完整结果（含 `logs`、已成功的块、`preflight`、`plan` 等），其中带非空 `error` 字段或 `ok: false`。常见于 `dryRun` 模拟失败、预检拦截、`create_token` / `manage_token2022` / `mixed_transfer` 链上失败、`batch_transfer` 某块失败。

两种情况都先读 `error.suggestion`（嵌在哪一层就读哪一层），它是修复建议，按它行动。链上程序错误还会带 `error.custom = { code, name?, instructionIndex?, programId }`：`programId` 是日志里报错的程序（无法判定时为 `null`）；只有确认是 SPL Token / Token-2022 时才有 `name`（枚举名：31 `MintRequiredForTransfer`、32 `FeeMismatch`、36 `NoMemo`、17 `AccountFrozen`……）并把 code 升级成 `TOKEN_<枚举名>`。其他程序（含 `solwallet_cpi`）的自定义错误一律 `PROGRAM_ERROR` + 裸 `custom.code`，要对照那个程序自己的错误表。

| code | 含义 | 正确动作 |
|---|---|---|
| `INVALID_INPUT` | 参数错误：钱包不存在、地址非 base58、代币腿缺 `mint`、金额不是 base units 整数串（传了 `"1.5"`、`"0"` 或负数）、同名钱包冲突等 | 没有上链，不要去浏览器查；按 `message` 修参数后重调 |
| `PREFLIGHT_BLOCKED` | 本地预检发现 block 级问题 | 读 `preflight.findings`，按上面代码表消除；确实要测链上行为才 `force: true` |
| `MINT_NOT_FOUND` | 预检 / 构造时 mint 在该集群不存在 | 核对 `cluster` 与 mint 地址 |
| `SIGNER_MISSING` | 交易需要 `authority` 的签名但没提供 | `transfer` 传 `authorityWallet`，或把 authority 改成 `walletName` |
| `SIGNER_NOT_REQUIRED` / `TX_NOT_FULLY_SIGNED` | 原始交易通道：钱包不是必需签名者 / 还有签名槽为空 | 核对 `plan.signers`；补签后再 `send_transaction` |
| `OWNER_OFF_CURVE` | `derive_address` 的 owner 是 PDA | 确认确实要给 PDA 算 ATA 才传 `allowOwnerOffCurve: true` |
| `MAINNET_NOT_ALLOWED` | 主网操作未确认 | 向用户确认后加 `allowMainnet: true` 重发 |
| `AIRDROP_NOT_SUPPORTED` | mainnet 上请求 airdrop | 主网只能转账充值，不要重试 |
| `FAUCET_UNAVAILABLE` | 公共水龙头已关闭（410） | 见下文水龙头章节，换路径 |
| `INSUFFICIENT_FUNDS` | 余额不够（金额/租金/手续费） | `get_balances` 核实，先补资金或调低金额 |
| `ACCOUNT_NOT_FUNDED` | 收款地址从未有过资金 | 先转一小笔 SOL，或保持 ATA 自动创建 |
| `ACCOUNT_NOT_FOUND` | mint / 账户在链上不存在 | 核对 cluster 与 mint 地址 |
| `ACCOUNT_OWNER_MISMATCH` | 代币转账把 ATA 地址当钱包地址传了，或 authority 无权 | `to` 传钱包地址，ATA 会自动派生；划转场景看 `AUTHORITY_NOT_DELEGATE` |
| `DECIMALS_INVALID` / `AMOUNT_INVALID` | decimals 超范围 / 金额格式问题（MCP 输入通常在 schema 层就被拒为 base units 错误） | 改成 base units 整数串后再发 |
| `BLOCKHASH_EXPIRED` | 区块哈希过期 | 重新调用工具即可（每次调用取新 blockhash） |
| `TRANSACTION_FAILED` / `TOKEN_<枚举名>` | 链上程序执行失败 | 确定性失败，重发无效；看 `error.custom.name` 与 `dryRun` 日志修参数 |
| `RATE_LIMITED` | RPC 限流（429） | 等几秒再试；频繁出现建议换付费 RPC |
| `SEND_FAILED` | 重试耗尽仍失败 | 按 suggestion 排查（RPC 健康 / 余额）后再试 |
| `SIMULATION_FAILED` | dry-run 或 validator 预检失败 | 读 `logs` / `error.custom` 定位失败指令，修参数后再发 |
| `UNKNOWN` | 未识别错误 | 读 `message` 自行判断 |

原则：同一调用原样重试**最多一次**（仅限 `RATE_LIMITED` / `BLOCKHASH_EXPIRED` / 网络类错误）。其余情况先修参数；重试前用 `list_wallets` / `get_balances` / `get_cluster_status` / `preflight_transfer` 核实状态。

## 水龙头现状与备选方案（2026-11）

devnet / testnet 的**公共 RPC 水龙头已关闭**（返回 410），`request_airdrop` 会报 `FAUCET_UNAVAILABLE`。三条替代路径，按场景推荐：

1. **网页水龙头**：让用户到 [faucet.solana.com](https://faucet.solana.com) 用 GitHub 验证领取（把目标地址粘进去）。领完直接 `get_balances` 确认。
2. **付费 RPC**：Helius / QuickNode 的 devnet 端点通常保留水龙头（单次上限约 5 SOL）。把完整 URL 作为 `cluster` 参数直接传给 `request_airdrop`，例如 `cluster: "https://devnet.helius-rpc.com/?api-key=<KEY>"`。
3. **本地 validator**（离线、无限量、最适合批量测试）：用户运行 `solana-test-validator` 后，所有工具调用传 `cluster: "http://127.0.0.1:8899"`（或建议用户把 `SOLWALLET_CLUSTER` 环境变量设为该地址，免去每次传参）。本地 validator 自带水龙头，`request_airdrop` 不受限。

## 红线

1. 用户没有明确要求备份 / 导出，**绝不调用 `export_secret`**。
2. mainnet-beta 的任何发送（含 `send_transaction`）：先向用户复述金额与接收地址，得到确认后才传 `allowMainnet: true`。
3. 密钥材料一旦导出，不在回复正文中复述助记词内容，只提示保存方式。备份给 CLI 用选 `format: "keyfileJson"`（与 `solana-keygen` 兼容），给其他钱包 App 用选 `"mnemonic"`。
4. 不可逆操作（`setMintAuthority` / `setFreezeAuthority` 传 `null` 放弃权限、`nonTransferable` 代币、`permanent-delegate` 预设）先向用户确认再执行。
5. 同名钱包冲突不要自作主张传 `overwrite: true`，先问用户。
6. `force: true` 只用于"用户明确要测链上失败路径"；不要拿它绕过 `MEMO_REQUIRED` / `ACCOUNT_FROZEN` 之类本应修参数的问题。
