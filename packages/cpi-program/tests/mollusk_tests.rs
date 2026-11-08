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

// ---------------------------------------------------------------------------
// forward_transfer_checked (PRD T-I): the program CPIs TransferChecked on
// SPL Token / Token-2022 with the caller as signing authority. The token
// programs are loaded into mollusk from their bundled ELFs.
// ---------------------------------------------------------------------------

use mollusk_svm_programs_token::{token, token2022};

/// Mirrors `INSTRUCTION_FORWARD_TRANSFER_CHECKED` in `src/lib.rs`.
const INSTRUCTION_FORWARD_TRANSFER_CHECKED: u8 = 2;
/// Mirrors `ERROR_INVALID_TOKEN_PROGRAM` in `src/lib.rs`.
const ERROR_INVALID_TOKEN_PROGRAM: u32 = 8;

/// Base (extension-less) SPL mint layout, 82 bytes. Token-2022 accepts the
/// same base layout for mints without extensions.
const MINT_LEN: usize = 82;
/// Base token-account layout, 165 bytes (shared by both token programs).
const TOKEN_ACCOUNT_LEN: usize = 165;
/// Offset of the `amount` field inside a token account.
const TOKEN_ACCOUNT_AMOUNT_OFFSET: usize = 64;

fn forward_transfer_checked_data(amount: u64, decimals: u8) -> Vec<u8> {
    let mut data = vec![INSTRUCTION_FORWARD_TRANSFER_CHECKED];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    data
}

/// Hand-rolled mint: COption<mint_authority>=Some(authority), supply,
/// decimals, is_initialized=1, COption<freeze_authority>=None.
fn mint_account(owner_program: &Pubkey, mint_authority: &Pubkey, decimals: u8) -> Account {
    let mut data = vec![0u8; MINT_LEN];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(mint_authority.as_ref());
    data[36..44].copy_from_slice(&1_000_000_000u64.to_le_bytes());
    data[44] = decimals;
    data[45] = 1;
    Account {
        lamports: Rent::default().minimum_balance(MINT_LEN),
        data,
        owner: *owner_program,
        executable: false,
        rent_epoch: 0,
    }
}

/// Hand-rolled token account: mint, owner, amount, delegate=None,
/// state=Initialized(1), is_native=None, delegated_amount=0, close=None.
fn token_account(owner_program: &Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; TOKEN_ACCOUNT_LEN];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // state = Initialized
    Account {
        lamports: Rent::default().minimum_balance(TOKEN_ACCOUNT_LEN),
        data,
        owner: *owner_program,
        executable: false,
        rent_epoch: 0,
    }
}

/// Shared scenario: `authority` owns `source` holding 1_000 units; forward
/// 250 units to `destination` through the given token program.
fn run_forward(
    token_program: &Pubkey,
    add: fn(&mut Mollusk),
    keyed_account: fn() -> (Pubkey, Account),
) {
    let program_id = Pubkey::new_unique();
    let mut mollusk = Mollusk::new(&program_id, "solwallet_cpi");
    add(&mut mollusk);

    let authority = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let source = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    let decimals = 6u8;
    let amount = 250u64;

    let instruction = Instruction::new_with_bytes(
        program_id,
        &forward_transfer_checked_data(amount, decimals),
        vec![
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
    );

    let accounts = vec![
        (authority, system_account(1_000_000_000)),
        (source, token_account(token_program, &mint, &authority, 1_000)),
        (mint, mint_account(token_program, &authority, decimals)),
        (destination, token_account(token_program, &mint, &Pubkey::new_unique(), 0)),
        keyed_account(),
    ];

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[
            Check::success(),
            Check::account(&source)
                .data_slice(TOKEN_ACCOUNT_AMOUNT_OFFSET, &750u64.to_le_bytes())
                .build(),
            Check::account(&destination)
                .data_slice(TOKEN_ACCOUNT_AMOUNT_OFFSET, &250u64.to_le_bytes())
                .build(),
        ],
    );
}

#[test]
fn forward_transfer_checked_moves_spl_token_via_cpi() {
    run_forward(&token::ID, token::add_program, token::keyed_account);
}

#[test]
fn forward_transfer_checked_moves_token2022_via_cpi() {
    run_forward(&token2022::ID, token2022::add_program, token2022::keyed_account);
}

#[test]
fn forward_transfer_checked_rejects_unknown_token_program() {
    let program_id = Pubkey::new_unique();
    let mollusk = Mollusk::new(&program_id, "solwallet_cpi");
    let authority = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let source = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    let (system_program_key, system_program_account) = keyed_account_for_system_program();

    // The System Program is executable but is not a token program — the
    // forwarder must refuse it before attempting any CPI.
    let instruction = Instruction::new_with_bytes(
        program_id,
        &forward_transfer_checked_data(1, 0),
        vec![
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(system_program_key, false),
        ],
    );
    let accounts = vec![
        (authority, system_account(1_000_000_000)),
        (source, token_account(&token::ID, &mint, &authority, 10)),
        (mint, mint_account(&token::ID, &authority, 0)),
        (destination, token_account(&token::ID, &mint, &authority, 0)),
        (system_program_key, system_program_account),
    ];

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[Check::err(ProgramError::Custom(ERROR_INVALID_TOKEN_PROGRAM))],
    );
}

#[test]
fn forward_transfer_checked_requires_authority_signature() {
    let program_id = Pubkey::new_unique();
    let mut mollusk = Mollusk::new(&program_id, "solwallet_cpi");
    token::add_program(&mut mollusk);
    let authority = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let source = Pubkey::new_unique();
    let destination = Pubkey::new_unique();

    let instruction = Instruction::new_with_bytes(
        program_id,
        &forward_transfer_checked_data(1, 0),
        vec![
            AccountMeta::new_readonly(authority, false), // not a signer
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(token::ID, false),
        ],
    );
    let accounts = vec![
        (authority, system_account(1_000_000_000)),
        (source, token_account(&token::ID, &mint, &authority, 10)),
        (mint, mint_account(&token::ID, &authority, 0)),
        (destination, token_account(&token::ID, &mint, &authority, 0)),
        token::keyed_account(),
    ];

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[Check::err(ProgramError::MissingRequiredSignature)],
    );
}
