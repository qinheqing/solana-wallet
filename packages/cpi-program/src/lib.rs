//! `solwallet_cpi` — minimal Solana BPF program for testing CPI batch
//! transfers from `@solwallet/core` (task #7, F4.4).
//!
//! Framework: [pinocchio](https://github.com/anza-xyz/pinocchio) — a
//! zero-dependency, no-alloc program framework. Chosen over Anchor because
//! it builds with plain `cargo-build-sbf` (no avm/anchor-cli toolchain) and
//! keeps the compiled artifact tiny. Only the core `pinocchio` crate is
//! used; the one System Program CPI this program makes (`CreateAccount`, in
//! `initialize_vault`) is built by hand (wire format: `u32-LE` discriminant
//! `0` + `u64-LE` lamports + `u64-LE` space + 32-byte owner pubkey),
//! avoiding the pinocchio/pinocchio-system version-pairing constraint
//! entirely (the cached `pinocchio-system` release available on this machine
//! is built against a materially newer, incompatible pinocchio API).
//!
//! `batch_transfer`'s payout is deliberately **not** a System Program CPI —
//! see its doc comment below for why that would not even compile against
//! the real runtime once the vault carries data.
//!
//! # Program model
//!
//! The program owns a single PDA "vault" (seeds: `[b"vault"]`), created via
//! the `initialize_vault` instruction and owned by this program (not the
//! System Program). The vault's 32-byte data holds the authority pubkey
//! that is allowed to withdraw from it. `batch_transfer` moves lamports OUT
//! of the vault to N recipients via direct lamport arithmetic (a program may
//! always debit an account it owns and credit any writable account), but
//! only when the transaction's payer matches the stored authority. Solana's
//! runtime atomicity guarantees all-or-nothing behavior: if any step in the
//! instruction fails the whole transaction is rolled back.
//!
//! # Instructions
//!
//! ## `initialize_vault(authority: Pubkey)` — discriminant `0`
//!
//! Creates the vault PDA (via a System Program `CreateAccount` CPI signed by
//! the PDA's own seeds) and stores `authority` as the only signer allowed to
//! later withdraw via `batch_transfer`. Fails if the vault already exists
//! (no re-initialization / authority-overwrite path).
//!
//! Data layout (all integers little-endian, hand-rolled — no borsh):
//!
//! | bytes | field                 |
//! |-------|-----------------------|
//! | 1     | discriminant (`0`)    |
//! | 32    | authority pubkey      |
//!
//! Accounts:
//!
//! | index | account      | flags                                   |
//! |-------|--------------|------------------------------------------|
//! | 0     | payer        | signer, writable (funds rent)             |
//! | 1     | vault PDA    | writable, must not already exist          |
//! | 2     | system program | readonly                                 |
//!
//! ## `batch_transfer(recipients: &[Pubkey], lamports: &[u64])` — discriminant `1`
//!
//! Data layout (all integers little-endian, hand-rolled — no borsh):
//!
//! | bytes             | field                          |
//! |-------------------|--------------------------------|
//! | 1                 | discriminant (`1`)             |
//! | 2                 | item count (u16)               |
//! | count × (32 + 8)  | per item: recipient pk, lamports |
//!
//! Accounts:
//!
//! | index | account              | flags                                 |
//! |-------|----------------------|---------------------------------------|
//! | 0     | payer                | signer, writable (tx fees)            |
//! | 1     | vault PDA            | writable, owned by this program, initialized |
//! | 2     | system program       | readonly (validated, not invoked — kept for a stable account layout) |
//! | 3..   | recipients (count ×) | writable, system-owned or unfunded    |
//!
//! `payer` must be the signer AND must match the 32-byte authority stored in
//! the vault's data — this is the core access-control check. Anyone can
//! still *see* the vault address (it is a deterministic PDA), but only the
//! stored authority can move funds out of it.
//!
//! The payout itself moves lamports by direct arithmetic on the vault and
//! recipient accounts rather than via a System Program CPI. This is not
//! optional: the real System Program `Transfer` instruction refuses to debit
//! any account that carries data ("Transfer: `from` must not carry data" —
//! confirmed against the actual system processor via the `mollusk-svm` tests
//! in `tests/mollusk_tests.rs`), and the vault necessarily carries data (the
//! stored authority). A program may always debit lamports from an account it
//! owns and credit lamports to any writable account — this is the standard
//! pattern for PDA vaults that hold state, and is strictly cheaper than a
//! CPI per recipient besides.
//!
//! ## `forward_transfer_checked(amount: u64, decimals: u8)` — discriminant `2`
//!
//! A pure *forwarder*: the program CPIs `TransferChecked` (instruction
//! index 12) on the given token program (SPL Token or Token-2022) with the
//! caller as the source authority. No PDA signing is involved — the only
//! purpose is that the token movement lands as an **inner** instruction
//! (`meta.innerInstructions`) so transaction parsers can be exercised
//! against real CPI-originated token transfers (PRD T-I).
//!
//! Data layout (all integers little-endian, hand-rolled — no borsh):
//!
//! | bytes | field                 |
//! |-------|-----------------------|
//! | 1     | discriminant (`2`)    |
//! | 8     | amount (u64)          |
//! | 1     | decimals (u8)         |
//!
//! Accounts:
//!
//! | index | account                  | flags                                         |
//! |-------|--------------------------|-----------------------------------------------|
//! | 0     | authority                | signer (source owner or delegate)             |
//! | 1     | source token account     | writable                                      |
//! | 2     | mint                     | readonly                                      |
//! | 3     | destination token account| writable                                      |
//! | 4     | token program            | readonly; must be SPL Token or Token-2022     |
//! | 5..   | extra accounts (optional)| passed through verbatim (e.g. TransferHook)   |
//!
//! The token program id is validated against the two known ids; anything
//! else fails with `ERROR_INVALID_TOKEN_PROGRAM` (0x8). Accounts after the
//! fifth are appended to the CPI with their own signer/writable flags, which
//! is what a Token-2022 mint with a TransferHook needs.
//!
//! # Custom errors (surface as `custom program error: 0x…`)
//!
//! | code | meaning                                               |
//! |------|--------------------------------------------------------|
//! | 0x1  | vault balance too low for the total payout              |
//! | 0x2  | empty payout (total lamports is zero)                   |
//! | 0x3  | invalid account layout (missing/mismatch)               |
//! | 0x4  | vault is not initialized (no stored authority yet)      |
//! | 0x5  | signer does not match the vault's stored authority      |
//! | 0x6  | vault already initialized (re-init / takeover attempt)  |
//! | 0x7  | payout would leave the vault non-zero but below rent-exemption |
//! | 0x8  | token program account is neither SPL Token nor Token-2022       |

use pinocchio::account_info::AccountInfo;
use pinocchio::entrypoint;
use pinocchio::instruction::{AccountMeta, Instruction, Seed, Signer};
use pinocchio::program::{invoke_signed, slice_invoke};
use pinocchio::program_error::ProgramError;
use pinocchio::pubkey::{find_program_address, Pubkey};
use pinocchio::sysvars::rent::Rent;
use pinocchio::sysvars::Sysvar;

/// The System Program id (`111…111` = 32 zero bytes), used both for owner
/// checks and as the CPI call target.
const SYSTEM_PROGRAM_ID: Pubkey = [0u8; 32];

/// System Program `CreateAccount` instruction discriminant (LE u32 on the wire).
const SYSTEM_CREATE_ACCOUNT_DISCRIMINANT: u32 = 0;

/// SPL Token program id (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
pub const TOKEN_PROGRAM_ID: Pubkey = [
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133,
    237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
];
/// Token-2022 program id (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
pub const TOKEN_2022_PROGRAM_ID: Pubkey = [
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
];

/// Token / Token-2022 `TransferChecked` instruction index (shared by both).
const TOKEN_TRANSFER_CHECKED_DISCRIMINANT: u8 = 12;

/// Seed for the program-controlled SOL vault PDA.
pub const VAULT_SEED: &[u8] = b"vault";

/// Size of the vault account's data: just the 32-byte stored authority.
pub const VAULT_DATA_LEN: usize = 32;

/// Discriminant byte for the `initialize_vault` instruction.
pub const INSTRUCTION_INITIALIZE_VAULT: u8 = 0;
/// Discriminant byte for the `batch_transfer` instruction.
pub const INSTRUCTION_BATCH_TRANSFER: u8 = 1;
/// Discriminant byte for the `forward_transfer_checked` instruction.
pub const INSTRUCTION_FORWARD_TRANSFER_CHECKED: u8 = 2;

/// Custom error: vault does not hold enough lamports for the payout.
pub const ERROR_INSUFFICIENT_FUNDS: u32 = 1;
/// Custom error: total payout is zero.
pub const ERROR_ZERO_PAYOUT: u32 = 2;
/// Custom error: account list does not match the expected layout.
pub const ERROR_INVALID_ACCOUNTS: u32 = 3;
/// Custom error: vault has not been initialized via `initialize_vault` yet.
pub const ERROR_VAULT_UNINITIALIZED: u32 = 4;
/// Custom error: signer does not match the vault's stored authority.
pub const ERROR_UNAUTHORIZED: u32 = 5;
/// Custom error: vault already initialized (re-init attempt rejected).
pub const ERROR_VAULT_ALREADY_INITIALIZED: u32 = 6;
/// Custom error: payout would leave the vault non-zero but below the
/// rent-exempt minimum for its data length.
pub const ERROR_VAULT_NOT_RENT_EXEMPT: u32 = 7;
/// Custom error: `forward_transfer_checked` was given a token program
/// account that is neither SPL Token nor Token-2022.
pub const ERROR_INVALID_TOKEN_PROGRAM: u32 = 8;

/// Byte size of one `batch_transfer` instruction-data item (32-byte pubkey +
/// 8-byte lamports).
const ITEM_SIZE: usize = 32 + 8;
/// `batch_transfer` header size: 1-byte discriminant + 2-byte count.
const HEADER_SIZE: usize = 3;
/// `initialize_vault` instruction-data size: 1-byte discriminant + 32-byte
/// authority pubkey.
const INITIALIZE_VAULT_DATA_LEN: usize = 1 + 32;
/// `forward_transfer_checked` instruction-data size: 1-byte discriminant +
/// 8-byte amount + 1-byte decimals.
const FORWARD_TRANSFER_CHECKED_DATA_LEN: usize = 1 + 8 + 1;
/// Fixed (non-pass-through) accounts of `forward_transfer_checked`.
const FORWARD_TRANSFER_CHECKED_FIXED_ACCOUNTS: usize = 5;

entrypoint!(process_instruction);

/// Program entrypoint: decode + dispatch on the discriminant byte.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> Result<(), ProgramError> {
    match instruction_data.first() {
        Some(&INSTRUCTION_INITIALIZE_VAULT) => {
            process_initialize_vault(program_id, instruction_data, accounts)
        }
        Some(&INSTRUCTION_BATCH_TRANSFER) => {
            process_batch_transfer(program_id, instruction_data, accounts)
        }
        Some(&INSTRUCTION_FORWARD_TRANSFER_CHECKED) => {
            process_forward_transfer_checked(instruction_data, accounts)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// `initialize_vault`: create the vault PDA (owned by this program) and
/// store `authority` as the only signer later allowed to withdraw from it.
///
/// Rejects re-initialization outright — once a vault exists, this
/// instruction can never run again against the same PDA, which prevents an
/// attacker from overwriting the stored authority and taking the vault over.
fn process_initialize_vault(
    program_id: &Pubkey,
    data: &[u8],
    accounts: &[AccountInfo],
) -> Result<(), ProgramError> {
    if data.len() != INITIALIZE_VAULT_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let authority: Pubkey = data[1..33].try_into().unwrap();

    // ---- Validate account layout ---------------------------------------
    // [0] payer (signer) [1] vault PDA (not yet existing) [2] system program.
    if accounts.len() != 3 {
        return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
    }
    let payer = &accounts[0];
    let vault = &accounts[1];
    let system_program = &accounts[2];

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
    }

    let (expected_vault, bump) = find_program_address(&[VAULT_SEED], program_id);
    if *vault.key() != expected_vault || !vault.is_writable() {
        return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
    }
    // The vault must not already exist — otherwise this instruction could be
    // replayed to overwrite the stored authority and steal the vault.
    if vault.owner() != &SYSTEM_PROGRAM_ID || vault.lamports() != 0 {
        return Err(ProgramError::Custom(ERROR_VAULT_ALREADY_INITIALIZED));
    }

    // ---- CPI: System Program CreateAccount, signed by the vault PDA ----
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(VAULT_DATA_LEN);

    // Hand-rolled System Program CreateAccount:
    //   data     = u32-LE discriminant (0) + u64-LE lamports + u64-LE space
    //              + 32-byte owner pubkey
    //   accounts = [from (payer, writable, signer), to (vault, writable, signer)]
    let mut cpi_data = [0u8; 52];
    cpi_data[0..4].copy_from_slice(&SYSTEM_CREATE_ACCOUNT_DISCRIMINANT.to_le_bytes());
    cpi_data[4..12].copy_from_slice(&lamports.to_le_bytes());
    cpi_data[12..20].copy_from_slice(&(VAULT_DATA_LEN as u64).to_le_bytes());
    cpi_data[20..52].copy_from_slice(&program_id[..]);

    let cpi_accounts = [
        AccountMeta::new(payer.key(), true, true),
        AccountMeta::new(vault.key(), true, true),
        AccountMeta::readonly(system_program.key()),
    ];

    let bump_seed = [bump];
    let seeds = [Seed::from(VAULT_SEED), Seed::from(&bump_seed)];
    let signers = [Signer::from(&seeds)];

    invoke_signed(
        &Instruction {
            program_id: &SYSTEM_PROGRAM_ID,
            accounts: &cpi_accounts,
            data: &cpi_data,
        },
        &[payer, vault, system_program],
        &signers,
    )?;

    // ---- Store the authority in the newly-created vault account --------
    let mut vault_data = vault.try_borrow_mut_data()?;
    if vault_data.len() < VAULT_DATA_LEN {
        return Err(ProgramError::AccountDataTooSmall);
    }
    vault_data[..VAULT_DATA_LEN].copy_from_slice(&authority);

    Ok(())
}

/// `batch_transfer`: pay `lamports[i]` to `recipients[i]` from the vault PDA,
/// authorized only when `payer` matches the vault's stored authority.
///
/// Parsed lazily — item i lives at `data[HEADER_SIZE + i*ITEM_SIZE …]` — so
/// no large stack buffers are needed (BPF stack frames are only 4 KB).
fn process_batch_transfer(
    program_id: &Pubkey,
    data: &[u8],
    accounts: &[AccountInfo],
) -> Result<(), ProgramError> {
    // ---- Decode + validate instruction data ----------------------------
    if data.len() < HEADER_SIZE {
        return Err(ProgramError::InvalidInstructionData);
    }
    let count = u16::from_le_bytes([data[1], data[2]]) as usize;
    if data.len() != HEADER_SIZE + count * ITEM_SIZE {
        return Err(ProgramError::InvalidInstructionData);
    }

    // ---- Validate account layout ---------------------------------------
    // [0] payer (signer) [1] vault PDA [2] system program [3..] recipients.
    if accounts.len() != 3 + count {
        return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
    }
    let payer = &accounts[0];
    let vault = &accounts[1];
    let system_program = &accounts[2];
    let recipient_infos = &accounts[3..];

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
    }
    // The vault must be this program's PDA at seeds [b"vault"] — otherwise a
    // caller could substitute any system-owned account they control.
    let (expected_vault, _bump) = find_program_address(&[VAULT_SEED], program_id);
    if vault.owner() != program_id || *vault.key() != expected_vault || !vault.is_writable() {
        return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
    }

    // ---- Authorization: payer must match the vault's stored authority --
    // This is the core access-control fix: previously *any* signer could
    // drain the vault. The vault's data holds the only pubkey allowed here.
    if vault.data_len() < VAULT_DATA_LEN {
        return Err(ProgramError::Custom(ERROR_VAULT_UNINITIALIZED));
    }
    {
        let vault_data = vault.try_borrow_data()?;
        let stored_authority = &vault_data[..VAULT_DATA_LEN];
        if stored_authority != payer.key().as_ref() {
            return Err(ProgramError::Custom(ERROR_UNAUTHORIZED));
        }
    }

    // Each recipient must be writable and match the pubkey at the same
    // position in the instruction data. It must be system-owned (existing
    // funded account) or unfunded (system transfer will create it).
    for (i, info) in recipient_infos.iter().enumerate() {
        let item = &data[HEADER_SIZE + i * ITEM_SIZE..][..ITEM_SIZE];
        let recipient_pk: Pubkey = item[..32].try_into().unwrap();
        if !info.is_writable() || *info.key() != recipient_pk {
            return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
        }
        if info.owner() != &SYSTEM_PROGRAM_ID && info.lamports() != 0 {
            return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
        }
    }

    // ---- Balance pre-check ---------------------------------------------
    // The System Program CPI would reject an overdraw anyway; checking here
    // first gives a crisp custom error instead of a generic loader failure.
    let mut total: u64 = 0;
    for i in 0..count {
        let item = &data[HEADER_SIZE + i * ITEM_SIZE..][..ITEM_SIZE];
        let lamports = u64::from_le_bytes(item[32..40].try_into().unwrap());
        total = total
            .checked_add(lamports)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    if total == 0 {
        return Err(ProgramError::Custom(ERROR_ZERO_PAYOUT));
    }
    if vault.lamports() < total {
        return Err(ProgramError::Custom(ERROR_INSUFFICIENT_FUNDS));
    }

    // ---- Payout loop: vault --SOL--> each recipient ----------------------
    // This moves lamports by direct arithmetic on the account structs, NOT
    // via a System Program CPI. That isn't just an optimization — it's
    // required: the real System Program `Transfer` instruction refuses to
    // debit any account that carries data ("Transfer: `from` must not carry
    // data", confirmed against the actual system processor via mollusk-svm),
    // and the vault necessarily carries data (the stored authority). A
    // program may always debit lamports from an account it owns and credit
    // lamports to any writable account, which is exactly what's needed here
    // and is the standard pattern for PDA vaults that hold state.
    //
    // `system_program` is still required and validated above (it's used by
    // `initialize_vault`'s CPI and kept at a stable account index), but it is
    // not invoked by this instruction.
    for (i, recipient) in recipient_infos.iter().enumerate() {
        let item = &data[HEADER_SIZE + i * ITEM_SIZE..][..ITEM_SIZE];
        let lamports = u64::from_le_bytes(item[32..40].try_into().unwrap());

        let mut vault_lamports = vault.try_borrow_mut_lamports()?;
        let mut recipient_lamports = recipient.try_borrow_mut_lamports()?;
        let new_vault_lamports = vault_lamports
            .checked_sub(lamports)
            .ok_or(ProgramError::Custom(ERROR_INSUFFICIENT_FUNDS))?;
        let new_recipient_lamports = recipient_lamports
            .checked_add(lamports)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        *vault_lamports = new_vault_lamports;
        *recipient_lamports = new_recipient_lamports;
    }

    // ---- Post-payout floor check ----------------------------------------
    // Leaving the vault with a non-zero balance below the rent-exempt
    // minimum would make it liable for garbage collection by the runtime,
    // silently losing the remaining dust. Either drain it fully or leave it
    // rent-exempt.
    let remaining = vault.lamports();
    if remaining != 0 {
        let min_balance = Rent::get()?.minimum_balance(vault.data_len());
        if remaining < min_balance {
            return Err(ProgramError::Custom(ERROR_VAULT_NOT_RENT_EXEMPT));
        }
    }

    Ok(())
}

/// `forward_transfer_checked`: CPI `TransferChecked` on SPL Token or
/// Token-2022 with the caller (`authority`) as the signing source owner.
///
/// Nothing here is program-signed — the caller's own signature is simply
/// forwarded to the token program. The instruction exists so a token
/// transfer can be produced as an *inner* instruction on demand (for
/// exercising `inspectTransaction`-style parsers), not for custody.
fn process_forward_transfer_checked(
    data: &[u8],
    accounts: &[AccountInfo],
) -> Result<(), ProgramError> {
    // ---- Decode instruction data ---------------------------------------
    if data.len() != FORWARD_TRANSFER_CHECKED_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let decimals = data[9];

    // ---- Validate account layout ---------------------------------------
    // [0] authority (signer) [1] source (w) [2] mint [3] destination (w)
    // [4] token program [5..] pass-through extras (TransferHook etc.).
    if accounts.len() < FORWARD_TRANSFER_CHECKED_FIXED_ACCOUNTS {
        return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
    }
    let authority = &accounts[0];
    let source = &accounts[1];
    let mint = &accounts[2];
    let destination = &accounts[3];
    let token_program = &accounts[4];
    let extras = &accounts[FORWARD_TRANSFER_CHECKED_FIXED_ACCOUNTS..];

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !source.is_writable() || !destination.is_writable() {
        return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
    }
    let token_program_id = token_program.key();
    if token_program_id != &TOKEN_PROGRAM_ID && token_program_id != &TOKEN_2022_PROGRAM_ID {
        return Err(ProgramError::Custom(ERROR_INVALID_TOKEN_PROGRAM));
    }
    // Both token programs additionally require source/destination/mint to be
    // owned by them; we leave that to the callee so its own (well-known)
    // error codes surface unchanged in the logs.

    // ---- CPI: TransferChecked, hand-rolled ------------------------------
    //   data     = u8 discriminant (12) + u64-LE amount + u8 decimals
    //   accounts = [source (w), mint, destination (w), authority (signer),
    //               extras… (flags copied verbatim)]
    let mut cpi_data = [0u8; 10];
    cpi_data[0] = TOKEN_TRANSFER_CHECKED_DISCRIMINANT;
    cpi_data[1..9].copy_from_slice(&amount.to_le_bytes());
    cpi_data[9] = decimals;

    let mut cpi_metas: std::vec::Vec<AccountMeta> =
        std::vec::Vec::with_capacity(4 + extras.len());
    cpi_metas.push(AccountMeta::writable(source.key()));
    cpi_metas.push(AccountMeta::readonly(mint.key()));
    cpi_metas.push(AccountMeta::writable(destination.key()));
    cpi_metas.push(AccountMeta::readonly_signer(authority.key()));
    for extra in extras {
        cpi_metas.push(AccountMeta::new(extra.key(), extra.is_writable(), extra.is_signer()));
    }

    let mut cpi_infos: std::vec::Vec<&AccountInfo> =
        std::vec::Vec::with_capacity(4 + extras.len());
    cpi_infos.push(source);
    cpi_infos.push(mint);
    cpi_infos.push(destination);
    cpi_infos.push(authority);
    cpi_infos.extend(extras.iter());

    slice_invoke(
        &Instruction {
            program_id: token_program_id,
            accounts: &cpi_metas,
            data: &cpi_data,
        },
        &cpi_infos,
    )
}
