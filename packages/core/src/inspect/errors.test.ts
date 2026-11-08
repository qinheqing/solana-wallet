import { describe, expect, it } from "vitest";

import { parseTransactionError } from "../utils/parse-error.js";
import {
  SPL_TOKEN_ERROR_NAMES,
  TOKEN_2022_ERROR_NAMES,
  decodeInstructionError,
  tokenErrorName,
} from "./errors.js";

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

describe("decodeInstructionError (T-E)", () => {
  it("tables match the official enum ordering (spot checks)", () => {
    expect(SPL_TOKEN_ERROR_NAMES).toHaveLength(20);
    expect(TOKEN_2022_ERROR_NAMES).toHaveLength(69);
    expect(TOKEN_2022_ERROR_NAMES[3]).toBe("MintMismatch");
    expect(TOKEN_2022_ERROR_NAMES[31]).toBe("MintRequiredForTransfer");
    expect(TOKEN_2022_ERROR_NAMES[36]).toBe("NoMemo");
    expect(TOKEN_2022_ERROR_NAMES[42]).toBe("CpiGuardTransferBlocked");
    expect(TOKEN_2022_ERROR_NAMES[67]).toBe("MintPaused");
    expect(SPL_TOKEN_ERROR_NAMES[19]).toBe("NonNativeNotSupported");
  });

  it("decodes an err object and resolves programId through the message", () => {
    const d = decodeInstructionError(
      { InstructionError: [2, { Custom: 36 }] },
      { message: { instructions: [{ programId: SPL }, { programId: "11111111111111111111111111111111" }, { programId: T22 }] } },
    );
    expect(d).toEqual({ instructionIndex: 2, programId: T22, customCode: 36, name: "NoMemo" });
  });

  it("does not name codes beyond the legacy table for SPL Token, nor for foreign programs", () => {
    expect(decodeInstructionError({ InstructionError: [0, { Custom: 36 }] }, { programId: SPL })?.name).toBeUndefined();
    expect(decodeInstructionError({ InstructionError: [0, { Custom: 3 }] }, { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" })?.name).toBeUndefined();
    expect(tokenErrorName(null, 99)).toBeUndefined();
  });

  it("decodes 'custom program error: 0x1f' from a message string / Error with logs", () => {
    const d = decodeInstructionError("Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1f", { programId: T22 });
    expect(d).toEqual({ instructionIndex: 1, programId: T22, customCode: 31, name: "MintRequiredForTransfer" });
    const e = Object.assign(new Error("Simulation failed"), { logs: ["Program log: x", "custom program error: 0x24"] });
    expect(decodeInstructionError(e)?.customCode).toBe(36);
  });

  it("non-custom instruction errors keep the kind", () => {
    expect(decodeInstructionError({ InstructionError: [0, "InvalidAccountData"] })).toEqual({
      instructionIndex: 0, programId: null, customCode: null, kind: "InvalidAccountData",
    });
    expect(decodeInstructionError("nothing here")).toBeNull();
    expect(decodeInstructionError(null)).toBeNull();
  });
});

describe("parseTransactionError integration", () => {
  it("keeps the INSUFFICIENT_FUNDS rule but attaches custom (unattributed → no name)", () => {
    const p = parseTransactionError(new Error("failed: custom program error: 0x1"));
    expect(p.code).toBe("INSUFFICIENT_FUNDS");
    expect(p.custom).toEqual({ code: 1, programId: null });
  });

  it("names token errors as TOKEN_<Name> only when the program is known: from logs", () => {
    const e = Object.assign(new Error("Transaction simulation failed: Error processing Instruction 0: custom program error: 0x24"), {
      logs: [`Program ${T22} invoke [1]`, "Program log: Error: No memo in previous instruction", `Program ${T22} failed: custom program error: 0x24`],
    });
    const p = parseTransactionError(e);
    expect(p.code).toBe("SIMULATION_FAILED"); // regex rule keeps its code…
    expect(p.custom).toEqual({ code: 36, name: "NoMemo", instructionIndex: 0, programId: T22 }); // …but the decode is attributed
    expect(p.message).toContain(`Program ${T22} failed: custom program error: 0x24`);
    expect(p.suggestion).toMatch(/error\.custom/);
    const named = parseTransactionError(Object.assign(new Error("Error processing Instruction 0: custom program error: 0x24"), {
      logs: [`Program ${T22} failed: custom program error: 0x24`],
    }));
    expect(named.code).toBe("TOKEN_NoMemo");
    expect(named.suggestion).toMatch(/Memo/);
  });

  it("names token errors when the caller states the program", () => {
    const p = parseTransactionError(new Error("Error processing Instruction 0: custom program error: 0x24"), { programId: T22 });
    expect(p.code).toBe("TOKEN_NoMemo");
    expect(p.custom).toEqual({ code: 36, name: "NoMemo", instructionIndex: 0, programId: T22 });
    // Legacy SPL Token does not define code 36.
    const spl = parseTransactionError(new Error("custom program error: 0x24"), { programId: SPL });
    expect(spl.code).toBe("PROGRAM_ERROR");
    expect(spl.custom).toEqual({ code: 36, programId: SPL });
  });

  it("logs naming the failing program beat the caller's hint", () => {
    const foreign = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
    const e = Object.assign(new Error("Error processing Instruction 0: custom program error: 0x5"), {
      logs: [`Program ${foreign} failed: custom program error: 0x5`],
    });
    const p = parseTransactionError(e, { programId: T22 });
    expect(p.code).toBe("PROGRAM_ERROR");
    expect(p.custom).toEqual({ code: 5, instructionIndex: 0, programId: foreign });
  });

  it("an unattributed custom error is PROGRAM_ERROR, never a TOKEN_ code (cpi program custom 5 ≠ FixedSupply)", () => {
    const p = parseTransactionError(new Error("Error processing Instruction 0: custom program error: 0x5"));
    expect(p.code).toBe("PROGRAM_ERROR");
    expect(p.custom).toEqual({ code: 5, instructionIndex: 0, programId: null });
    expect(p.suggestion).toMatch(/unidentified program/);
    const foreign = parseTransactionError(new Error("custom program error: 0x5"), { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" });
    expect(foreign.code).toBe("PROGRAM_ERROR");
    expect(foreign.custom?.name).toBeUndefined();
  });

  it("falls back to PROGRAM_ERROR for unnamed codes", () => {
    const p = parseTransactionError(new Error("custom program error: 0x1770"), { programId: T22 });
    expect(p.code).toBe("PROGRAM_ERROR");
    expect(p.custom?.code).toBe(6000);
  });
});
