/**
 * InstructionError decoding: maps a transaction `err` object (or an error
 * message carrying "custom program error: 0x..") to the SPL Token /
 * Token-2022 `TokenError` enum name.
 *
 * Tables transcribed from the official Rust sources (variant order == code):
 *  - SPL Token:   solana-program/token      interface/src/error.rs   (0..19)
 *  - Token-2022:  solana-program/token-2022 interface/src/error.rs   (0..68)
 * The first 20 Token-2022 variants are identical to SPL Token's.
 */
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

/** Token-2022 `TokenError` variants, index == custom error code. */
export const TOKEN_2022_ERROR_NAMES: readonly string[] = [
  "NotRentExempt",
  "InsufficientFunds",
  "InvalidMint",
  "MintMismatch",
  "OwnerMismatch",
  "FixedSupply",
  "AlreadyInUse",
  "InvalidNumberOfProvidedSigners",
  "InvalidNumberOfRequiredSigners",
  "UninitializedState",
  "NativeNotSupported",
  "NonNativeHasBalance",
  "InvalidInstruction",
  "InvalidState",
  "Overflow",
  "AuthorityTypeNotSupported",
  "MintCannotFreeze",
  "AccountFrozen",
  "MintDecimalsMismatch",
  "NonNativeNotSupported",
  "ExtensionTypeMismatch",
  "ExtensionBaseMismatch",
  "ExtensionAlreadyInitialized",
  "ConfidentialTransferAccountHasBalance",
  "ConfidentialTransferAccountNotApproved",
  "ConfidentialTransferDepositsAndTransfersDisabled",
  "ConfidentialTransferElGamalPubkeyMismatch",
  "ConfidentialTransferBalanceMismatch",
  "MintHasSupply",
  "NoAuthorityExists",
  "TransferFeeExceedsMaximum",
  "MintRequiredForTransfer",
  "FeeMismatch",
  "FeeParametersMismatch",
  "ImmutableOwner",
  "AccountHasWithheldTransferFees",
  "NoMemo",
  "NonTransferable",
  "NonTransferableNeedsImmutableOwnership",
  "MaximumPendingBalanceCreditCounterExceeded",
  "MaximumDepositAmountExceeded",
  "CpiGuardSettingsLocked",
  "CpiGuardTransferBlocked",
  "CpiGuardBurnBlocked",
  "CpiGuardCloseAccountBlocked",
  "CpiGuardApproveBlocked",
  "CpiGuardSetAuthorityBlocked",
  "CpiGuardOwnerChangeBlocked",
  "ExtensionNotFound",
  "NonConfidentialTransfersDisabled",
  "ConfidentialTransferFeeAccountHasWithheldFee",
  "InvalidExtensionCombination",
  "InvalidLengthForAlloc",
  "AccountDecryption",
  "ProofGeneration",
  "InvalidProofInstructionOffset",
  "HarvestToMintDisabled",
  "SplitProofContextStateAccountsNotSupported",
  "NotEnoughProofContextStateAccounts",
  "MalformedCiphertext",
  "CiphertextArithmeticFailed",
  "PedersenCommitmentMismatch",
  "RangeProofLengthMismatch",
  "IllegalBitLength",
  "FeeCalculation",
  "IllegalMintBurnConversion",
  "InvalidScale",
  "MintPaused",
  "PendingBalanceNonZero",
];

/** SPL Token (legacy) `TokenError` variants — the shared prefix. */
export const SPL_TOKEN_ERROR_NAMES: readonly string[] = TOKEN_2022_ERROR_NAMES.slice(0, 20);

export interface DecodedInstructionError {
  /** Index of the failing top-level instruction, when known. */
  instructionIndex: number | null;
  /** Program that returned the error, when it could be resolved. */
  programId: string | null;
  /** Custom error code (`Custom(n)` / `custom program error: 0xn`). */
  customCode: number | null;
  /** Enum name from the token error tables; omitted when unresolvable. */
  name?: string;
  /** Non-custom instruction errors (e.g. "InvalidAccountData") verbatim. */
  kind?: string;
}

/** Minimal shape of a parsed transaction message for program resolution. */
export interface ParsedMessageLike {
  instructions: Array<{ programId: string | { toBase58(): string } }>;
}

export interface DecodeInstructionErrorOptions {
  /** Resolve `programId` from the failing instruction index. */
  message?: ParsedMessageLike;
  /** Explicit program id when the message is unavailable. */
  programId?: string;
}

const CUSTOM_HEX = /custom program error:\s*0x([0-9a-f]+)/i;
const INSTRUCTION_ERROR_TEXT =
  /InstructionError["']?\s*:?\s*\[\s*(\d+)\s*,\s*\{?\s*["']?Custom["']?\s*:?\s*(\d+)/i;

function keyToString(v: string | { toBase58(): string }): string {
  return typeof v === "string" ? v : v.toBase58();
}

/**
 * Resolve a Token/Token-2022 error name for a program + code. Legacy SPL
 * Token only defines 0..19; Token-2022 extends to 68. A foreign program is
 * never named, and neither is an unknown one (`programId: null`): every
 * program numbers its custom errors from 0, so a bare "custom program
 * error: 0x5" could just as well be some other program's variant 5.
 */
export function tokenErrorName(programId: string | null, code: number): string | undefined {
  if (programId === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_ERROR_NAMES[code];
  if (programId === TOKEN_PROGRAM_ID.toBase58()) return SPL_TOKEN_ERROR_NAMES[code];
  return undefined;
}

/** Whether a program id is SPL Token or Token-2022. */
export function isTokenProgramId(programId: string | null | undefined): boolean {
  return programId === TOKEN_2022_PROGRAM_ID.toBase58() || programId === TOKEN_PROGRAM_ID.toBase58();
}

const FAILED_PROGRAM_LOG = /Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: custom program error: 0x([0-9a-f]+)/i;

/**
 * Infer the failing program from simulation / send logs: the runtime logs
 * `Program <id> failed: custom program error: 0x..` for the program that
 * returned the error (an inner program when the failure happened inside a
 * CPI). Returns null when no such line is present.
 */
export function programIdFromLogs(text: string | readonly string[] | undefined | null): string | null {
  if (!text) return null;
  const joined = typeof text === "string" ? text : text.join("\n");
  const m = FAILED_PROGRAM_LOG.exec(joined);
  return m?.[1] ?? null;
}

/**
 * Decode a transaction error. Accepts the raw RPC `err` object
 * (`{ InstructionError: [idx, { Custom: n }] }` or `[idx, "SomeKind"]`),
 * an Error / string containing "custom program error: 0x1f", or a
 * JSON-stringified form of either. Returns null when nothing decodable.
 */
export function decodeInstructionError(
  err: unknown,
  opts: DecodeInstructionErrorOptions = {},
): DecodedInstructionError | null {
  const base = fromObject(err) ?? fromText(err);
  if (!base) return null;
  let programId = opts.programId ?? null;
  if (!programId && opts.message && base.instructionIndex !== null) {
    const ix = opts.message.instructions[base.instructionIndex];
    if (ix) programId = keyToString(ix.programId);
  }
  const out: DecodedInstructionError = { ...base, programId };
  if (base.customCode !== null) {
    const name = tokenErrorName(programId, base.customCode);
    if (name) out.name = name;
  }
  return out;
}

function fromObject(err: unknown): Omit<DecodedInstructionError, "programId"> | null {
  if (!err || typeof err !== "object") return null;
  const ie = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie.length < 2) return null;
  const idx = typeof ie[0] === "number" ? ie[0] : null;
  const detail = ie[1];
  if (detail && typeof detail === "object" && "Custom" in detail) {
    const code = (detail as { Custom: unknown }).Custom;
    return {
      instructionIndex: idx,
      customCode: typeof code === "number" ? code : null,
    };
  }
  return {
    instructionIndex: idx,
    customCode: null,
    kind: typeof detail === "string" ? detail : JSON.stringify(detail),
  };
}

function fromText(err: unknown): Omit<DecodedInstructionError, "programId"> | null {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? [err.message, ...((err as { logs?: string[] }).logs ?? [])].join("\n")
        : null;
  if (!text) return null;
  // A serialised err object inside a message, e.g. from sendAndConfirm.
  const structured = INSTRUCTION_ERROR_TEXT.exec(text);
  if (structured) {
    return { instructionIndex: Number(structured[1]), customCode: Number(structured[2]) };
  }
  const hex = CUSTOM_HEX.exec(text);
  if (hex) {
    const idx = /Error processing Instruction (\d+)/i.exec(text);
    return {
      instructionIndex: idx ? Number(idx[1]) : null,
      customCode: parseInt(hex[1] ?? "0", 16),
    };
  }
  return null;
}
