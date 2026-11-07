//! `solwallet_cpi` — minimal Solana BPF program for testing CPI batch
//! transfers from `@solwallet/core` (task #7, F4.4).
//!
//! Framework: [pinocchio](https://github.com/anza-xyz/pinocchio) — a
//! zero-dependency, no-alloc program framework. Chosen over Anchor because
//! it builds with plain `cargo-build-sbf` (no avm/anchor-cli toolchain) and
//! keeps the compiled artifact tiny. Only the core `pinocchio` crate is
//! used; the System Program CPI is built by hand (its wire format is just
//! `u32-LE` discriminant `2` + `u64-LE` lamports), avoiding the
//! pinocchio/pinocchio-system version-pairing constraint entirely.
//!
//! # Program model
//!
//! The program owns a single PDA "vault" (seeds: `[b"vault"]`). Anyone can
//! fund it with a plain SOL transfer to the vault address. The sole
//! instruction, `batch_transfer`, moves lamports OUT of the vault to N
//! recipients via one System Program CPI per recipient, each signed by the
//! vault PDA. Solana's runtime atomicity guarantees all-or-nothing behavior:
//! if any CPI fails the whole transaction (and every earlier transfer in
//! the loop) is rolled back.
//!
//! # Instruction
//!
//! `batch_transfer(recipients: &[Pubkey], lamports: &[u64])`
//!
//! Data layout (all integers little-endian, hand-rolled — no borsh):
//!
//! | bytes             | field                          |
//! |-------------------|--------------------------------|
//! | 1                 | discriminant (`1`)             |
//! | 2                 | item count (u16)               |
//! | count × (32 + 8)  | per item: recipient pk, lamports |
//!
//! # Accounts
//!
//! | index | account              | flags                                 |
//! |-------|----------------------|---------------------------------------|
//! | 0     | payer/authority      | signer, writable (tx fees)            |
//! | 1     | vault PDA            | writable, owned by this program       |
//! | 2..   | recipients (count ×) | writable, system-owned or unfunded    |
//!
//! # Custom errors (surface as `custom program error: 0x…`)
//!
//! | code | meaning                                    |
//! |------|--------------------------------------------|
//! | 0x1  | vault balance too low for the total payout |
//! | 0x2  | empty payout (total lamports is zero)      |
//! | 0x3  | invalid account layout (missing/mismatch)  |

use pinocchio::account_info::AccountInfo;
use pinocchio::entrypoint;
use pinocchio::instruction::{AccountMeta, Instruction, Seed, Signer};
use pinocchio::program::invoke_signed;
use pinocchio::program_error::ProgramError;
use pinocchio::pubkey::{find_program_address, Pubkey};

/// The System Program id (`111…111` = 32 zero bytes), used both for owner
/// checks and as the CPI call target.
const SYSTEM_PROGRAM_ID: Pubkey = [0u8; 32];

/// System Program `Transfer` instruction discriminant (LE u32 on the wire).
const SYSTEM_TRANSFER_DISCRIMINANT: u32 = 2;

/// Seed for the program-controlled SOL vault PDA.
pub const VAULT_SEED: &[u8] = b"vault";

/// Discriminant byte for the `batch_transfer` instruction.
pub const INSTRUCTION_BATCH_TRANSFER: u8 = 1;

/// Custom error: vault does not hold enough lamports for the payout.
pub const ERROR_INSUFFICIENT_FUNDS: u32 = 1;
/// Custom error: total payout is zero.
pub const ERROR_ZERO_PAYOUT: u32 = 2;
/// Custom error: account list does not match the expected layout.
pub const ERROR_INVALID_ACCOUNTS: u32 = 3;

/// Byte size of one instruction-data item (32-byte pubkey + 8-byte lamports).
const ITEM_SIZE: usize = 32 + 8;
/// Header size: 1-byte discriminant + 2-byte count.
const HEADER_SIZE: usize = 3;

entrypoint!(process_instruction);

/// Program entrypoint: decode + dispatch on the discriminant byte.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> Result<(), ProgramError> {
    match instruction_data.first() {
        Some(&INSTRUCTION_BATCH_TRANSFER) => {
            process_batch_transfer(program_id, instruction_data, accounts)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// `batch_transfer`: pay `lamports[i]` to `recipients[i]` from the vault PDA.
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
    // [0] payer/authority (signer) [1] vault PDA [2..] recipients.
    if accounts.len() != 2 + count {
        return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
    }
    let payer = &accounts[0];
    let vault = &accounts[1];
    let recipient_infos = &accounts[2..];

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // The vault must be this program's PDA at seeds [b"vault"] — otherwise a
    // caller could substitute any system-owned account they control.
    let (expected_vault, bump) = find_program_address(&[VAULT_SEED], program_id);
    if vault.owner() != program_id || *vault.key() != expected_vault || !vault.is_writable() {
        return Err(ProgramError::Custom(ERROR_INVALID_ACCOUNTS));
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

    // ---- CPI loop: vault --SOL--> each recipient ------------------------
    // Each transfer is signed by the vault PDA. The bump comes from
    // find_program_address above — with a single seed pair recomputing it
    // is cheaper than storing it in the vault account.
    let bump_seed = [bump];
    let seeds = [Seed::from(VAULT_SEED), Seed::from(&bump_seed)];
    let signers = [Signer::from(&seeds)];

    for (i, recipient) in recipient_infos.iter().enumerate() {
        let item = &data[HEADER_SIZE + i * ITEM_SIZE..][..ITEM_SIZE];
        let lamports = u64::from_le_bytes(item[32..40].try_into().unwrap());

        // Hand-rolled System Program Transfer:
        //   data     = u32-LE discriminant (2) + u64-LE lamports
        //   accounts = [from (vault, writable), to (recipient, writable)]
        let mut cpi_data = [0u8; 12];
        cpi_data[..4].copy_from_slice(&SYSTEM_TRANSFER_DISCRIMINANT.to_le_bytes());
        cpi_data[4..].copy_from_slice(&lamports.to_le_bytes());
        let cpi_accounts = [
            AccountMeta::new(vault.key(), true, false),
            AccountMeta::new(recipient.key(), true, false),
        ];
        invoke_signed(
            &Instruction {
                program_id: &SYSTEM_PROGRAM_ID,
                accounts: &cpi_accounts,
                data: &cpi_data,
            },
            &[vault, recipient],
            &signers,
        )?;
    }

    Ok(())
}
