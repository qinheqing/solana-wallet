//! On-chain-logic tests for `solwallet_cpi` using `mollusk-svm` — a
//! lightweight SVM harness that executes the real, built `.so` (via the BPF
//! loader + syscalls) with no live validator needed.
//!
//! Run with `cargo test` (NOT `cargo test-sbf`): these tests run on the host
//! and load `target/deploy/solwallet_cpi.so`, which must already exist —
//! run `cargo build-sbf` first.
//!
//! These exercise the critical-vuln fix directly: an unauthorized signer
//! must be rejected, the correct authority must succeed, and an
//! uninitialized vault must be rejected — none of this is observable from
//! the TS-side wire-format tests in `packages/core`.

use mollusk_svm::{program::keyed_account_for_system_program, result::Check, Mollusk};
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
};
use solana_sdk_ids::system_program;

/// Mirrors `INSTRUCTION_INITIALIZE_VAULT` in `src/lib.rs`.
const INSTRUCTION_INITIALIZE_VAULT: u8 = 0;
/// Mirrors `INSTRUCTION_BATCH_TRANSFER` in `src/lib.rs`.
const INSTRUCTION_BATCH_TRANSFER: u8 = 1;
/// Mirrors `ERROR_VAULT_UNINITIALIZED` in `src/lib.rs`.
const ERROR_VAULT_UNINITIALIZED: u32 = 4;
/// Mirrors `ERROR_UNAUTHORIZED` in `src/lib.rs`.
const ERROR_UNAUTHORIZED: u32 = 5;

fn vault_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault"], program_id)
}

fn initialize_vault_data(authority: &Pubkey) -> Vec<u8> {
    let mut data = vec![INSTRUCTION_INITIALIZE_VAULT];
    data.extend_from_slice(authority.as_ref());
    data
}

fn batch_transfer_data(recipients: &[(Pubkey, u64)]) -> Vec<u8> {
    let mut data = vec![INSTRUCTION_BATCH_TRANSFER];
    data.extend_from_slice(&(recipients.len() as u16).to_le_bytes());
    for (pk, lamports) in recipients {
        data.extend_from_slice(pk.as_ref());
        data.extend_from_slice(&lamports.to_le_bytes());
    }
    data
}

/// A funded, system-owned account — the shape of a normal wallet/keypair
/// account before it has ever been touched by this program.
fn system_account(lamports: u64) -> Account {
    Account::new(lamports, 0, &system_program::id())
}

#[test]
fn initialize_vault_sets_authority_and_program_ownership() {
    let program_id = Pubkey::new_unique();
    let mollusk = Mollusk::new(&program_id, "solwallet_cpi");
    let (vault, _bump) = vault_pda(&program_id);

    // Authority need not equal the payer — a relayer can fund the vault for
    // a cold-wallet-controlled authority.
    let payer = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let (system_program_key, system_program_account) = keyed_account_for_system_program();

    let instruction = Instruction::new_with_bytes(
        program_id,
        &initialize_vault_data(&authority),
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program_key, false),
        ],
    );

    let accounts = vec![
        (payer, system_account(10_000_000_000)),
        (vault, system_account(0)), // not yet created: 0 lamports, system-owned
        (system_program_key, system_program_account),
    ];

    let min_balance = Rent::default().minimum_balance(32);

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[
            Check::success(),
            Check::account(&vault)
                .owner(&program_id)
                .data_slice(0, authority.as_ref())
                .lamports(min_balance)
                .build(),
        ],
    );
}

#[test]
fn initialize_vault_rejects_reinitialization() {
    let program_id = Pubkey::new_unique();
    let mollusk = Mollusk::new(&program_id, "solwallet_cpi");
    let (vault, _bump) = vault_pda(&program_id);
    let payer = Pubkey::new_unique();
    let existing_authority = Pubkey::new_unique();
    let attacker_authority = Pubkey::new_unique();
    let (system_program_key, system_program_account) = keyed_account_for_system_program();

    let mut vault_account = Account::new(Rent::default().minimum_balance(32), 32, &program_id);
    vault_account.data[..32].copy_from_slice(existing_authority.as_ref());

    let instruction = Instruction::new_with_bytes(
        program_id,
        &initialize_vault_data(&attacker_authority),
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program_key, false),
        ],
    );

    let accounts = vec![
        (payer, system_account(10_000_000_000)),
        (vault, vault_account),
        (system_program_key, system_program_account),
    ];

    // Re-initialization must be rejected outright — never silently
    // overwrite the stored authority (that would be a vault takeover).
    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[Check::err(ProgramError::Custom(6))], // ERROR_VAULT_ALREADY_INITIALIZED
    );
}

#[test]
fn batch_transfer_from_non_authority_is_rejected() {
    let program_id = Pubkey::new_unique();
    let mollusk = Mollusk::new(&program_id, "solwallet_cpi");
    let (vault, _bump) = vault_pda(&program_id);
    let authority = Pubkey::new_unique();
    let attacker = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let (system_program_key, system_program_account) = keyed_account_for_system_program();

    let min_balance = Rent::default().minimum_balance(32);
    let mut vault_account = Account::new(min_balance + 5_000_000, 32, &program_id);
    vault_account.data[..32].copy_from_slice(authority.as_ref());

    let instruction = Instruction::new_with_bytes(
        program_id,
        &batch_transfer_data(&[(recipient, 1_000_000)]),
        vec![
            AccountMeta::new(attacker, true),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program_key, false),
            AccountMeta::new(recipient, false),
        ],
    );

    let accounts = vec![
        (attacker, system_account(1_000_000_000)),
        (vault, vault_account),
        (system_program_key, system_program_account),
        (recipient, system_account(0)),
    ];

    // This is the core fix for the critical vuln: a signer who is NOT the
    // vault's stored authority must never be able to move funds out.
    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[Check::err(ProgramError::Custom(ERROR_UNAUTHORIZED))],
    );
}

#[test]
fn batch_transfer_from_authority_succeeds_and_moves_correct_lamports() {
    let program_id = Pubkey::new_unique();
    let mollusk = Mollusk::new(&program_id, "solwallet_cpi");
    let (vault, _bump) = vault_pda(&program_id);
    let authority = Pubkey::new_unique();
    let recipient_a = Pubkey::new_unique();
    let recipient_b = Pubkey::new_unique();
    let (system_program_key, system_program_account) = keyed_account_for_system_program();

    let min_balance = Rent::default().minimum_balance(32);
    let vault_starting_lamports = min_balance + 7_000_000;
    let mut vault_account = Account::new(vault_starting_lamports, 32, &program_id);
    vault_account.data[..32].copy_from_slice(authority.as_ref());

    let payout_a = 2_000_000u64;
    let payout_b = 3_000_000u64;

    let instruction = Instruction::new_with_bytes(
        program_id,
        &batch_transfer_data(&[(recipient_a, payout_a), (recipient_b, payout_b)]),
        vec![
            AccountMeta::new(authority, true),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program_key, false),
            AccountMeta::new(recipient_a, false),
            AccountMeta::new(recipient_b, false),
        ],
    );

    let accounts = vec![
        (authority, system_account(1_000_000_000)),
        (vault, vault_account),
        (system_program_key, system_program_account),
        (recipient_a, system_account(0)),
        (recipient_b, system_account(0)),
    ];

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[
            Check::success(),
            Check::account(&vault)
                .lamports(vault_starting_lamports - payout_a - payout_b)
                .build(),
            Check::account(&recipient_a).lamports(payout_a).build(),
            Check::account(&recipient_b).lamports(payout_b).build(),
        ],
    );
}

#[test]
fn batch_transfer_against_uninitialized_vault_is_rejected() {
    let program_id = Pubkey::new_unique();
    let mollusk = Mollusk::new(&program_id, "solwallet_cpi");
    let (vault, _bump) = vault_pda(&program_id);
    let payer = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let (system_program_key, system_program_account) = keyed_account_for_system_program();

    // Owned by this program (so the PDA/owner gate passes) but never
    // initialized — zero-length data, no stored authority.
    let vault_account = Account::new(1_000_000, 0, &program_id);

    let instruction = Instruction::new_with_bytes(
        program_id,
        &batch_transfer_data(&[(recipient, 500_000)]),
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program_key, false),
            AccountMeta::new(recipient, false),
        ],
    );

    let accounts = vec![
        (payer, system_account(1_000_000_000)),
        (vault, vault_account),
        (system_program_key, system_program_account),
        (recipient, system_account(0)),
    ];

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[Check::err(ProgramError::Custom(ERROR_VAULT_UNINITIALIZED))],
    );
}
