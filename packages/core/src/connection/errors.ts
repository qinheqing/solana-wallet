/**
 * Structured error taxonomy for @solwallet/core.
 *
 * Every error carries a machine-readable `code` and a human/AI-readable
 * `hint` describing the recommended remediation — this lets MCP clients
 * self-correct without extra round-trips.
 */
export interface SolwalletErrorOptions {
  /** Stable machine-readable error code, e.g. "MAINNET_NOT_ALLOWED". */
  code: string;
  /** Recommended action, shown to humans and AI agents. */
  hint?: string;
  cause?: unknown;
}

export class SolwalletError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(message: string, options: SolwalletErrorOptions) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.hint = options.hint;
  }
}

/** A mutating operation was attempted on mainnet-beta without allowMainnet. */
export class MainnetNotAllowedError extends SolwalletError {
  constructor(cluster: string, operation: string) {
    super(
      `Refused to ${operation} on ${cluster}: real funds are at risk. Pass allowMainnet: true to confirm.`,
      {
        code: "MAINNET_NOT_ALLOWED",
        hint: `This guard prevents accidental mainnet spending. If you really intend to ${operation} on ${cluster}, pass { allowMainnet: true }. For free testing use devnet or testnet.`,
      },
    );
  }
}

/** Airdrop requested on mainnet-beta (real funds at risk). */
export class AirdropNotSupportedError extends SolwalletError {
  constructor(cluster: string) {
    super(`Airdrop is not allowed on cluster "${cluster}".`, {
      code: "AIRDROP_NOT_SUPPORTED",
      hint: "Airdrops work on devnet, testnet and localnet validators. On mainnet-beta, fund accounts by transferring real SOL.",
    });
  }
}

/** A transaction failed after send/confirm; carries the signature if known. */
export class TransactionSendError extends SolwalletError {
  readonly signature?: string;

  constructor(
    message: string,
    options: SolwalletErrorOptions & { signature?: string },
  ) {
    super(message, options);
    this.signature = options.signature;
  }
}
