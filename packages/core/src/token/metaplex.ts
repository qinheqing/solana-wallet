/**
 * Minimal Metaplex Token Metadata support for classic SPL mints: build
 * CreateMetadataAccountV3 by hand (no @metaplex-foundation dependency) and
 * decode name/symbol/uri back from a Metadata account.
 *
 * The Metaplex program is deployed on devnet/mainnet-beta but NOT on a bare
 * solana-test-validator; clone it there with
 *   --clone metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s --url devnet
 */
import {
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import { SolwalletError } from "../connection/errors.js";

export const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

/** Metaplex on-chain limits (bytes). */
export const METAPLEX_MAX_NAME_LEN = 32;
export const METAPLEX_MAX_SYMBOL_LEN = 10;
export const METAPLEX_MAX_URI_LEN = 200;

/** CreateMetadataAccountV3 instruction discriminator. */
const CREATE_METADATA_ACCOUNT_V3 = 33;

export interface TokenMetadataInput {
  name: string;
  symbol: string;
  /** Off-chain JSON URI; may be empty. */
  uri?: string;
}

export function metaplexMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Validate name/symbol/uri: both name and symbol required (no silent drop),
 * within the given byte limits. Throws METADATA_INVALID.
 */
export function validateTokenMetadata(
  meta: TokenMetadataInput,
  limits: { name: number; symbol: number; uri: number } = {
    name: METAPLEX_MAX_NAME_LEN,
    symbol: METAPLEX_MAX_SYMBOL_LEN,
    uri: METAPLEX_MAX_URI_LEN,
  },
): void {
  const name = meta.name.trim();
  const symbol = meta.symbol.trim();
  const uri = (meta.uri ?? "").trim();
  if (!name || !symbol) {
    throw new SolwalletError("Token metadata needs both name and symbol.", {
      code: "METADATA_INVALID",
      hint: "Fill in both name and symbol, or leave both empty to create a token without metadata.",
    });
  }
  const checks: Array<[string, string, number]> = [
    ["name", name, limits.name],
    ["symbol", symbol, limits.symbol],
    ["uri", uri, limits.uri],
  ];
  for (const [field, value, max] of checks) {
    if (byteLen(value) > max) {
      throw new SolwalletError(`Token metadata ${field} is ${byteLen(value)} bytes; max is ${max}.`, {
        code: "METADATA_INVALID",
        hint: `Shorten ${field} to at most ${max} UTF-8 bytes.`,
      });
    }
  }
}

function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

/**
 * CreateMetadataAccountV3: data = [33] + DataV2{name, symbol, uri,
 * sellerFeeBasisPoints=0, creators=None, collection=None, uses=None}
 * + isMutable + collectionDetails=None.
 */
export function createMetaplexMetadataInstruction(params: {
  mint: PublicKey;
  mintAuthority: PublicKey;
  payer: PublicKey;
  updateAuthority: PublicKey;
  metadata: TokenMetadataInput;
  isMutable?: boolean;
}): TransactionInstruction {
  const { mint, mintAuthority, payer, updateAuthority, metadata } = params;
  const sellerFee = Buffer.alloc(2); // 0 bps
  const data = Buffer.concat([
    Buffer.from([CREATE_METADATA_ACCOUNT_V3]),
    borshString(metadata.name.trim()),
    borshString(metadata.symbol.trim()),
    borshString((metadata.uri ?? "").trim()),
    sellerFee,
    Buffer.from([0]), // creators: None
    Buffer.from([0]), // collection: None
    Buffer.from([0]), // uses: None
    Buffer.from([params.isMutable === false ? 0 : 1]),
    Buffer.from([0]), // collectionDetails: None
  ]);
  return new TransactionInstruction({
    programId: METAPLEX_TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metaplexMetadataPda(mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: mintAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: updateAuthority, isSigner: updateAuthority.equals(payer), isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Decode name/symbol/uri from a Metaplex Metadata account
 * (key u8 | updateAuthority 32 | mint 32 | name | symbol | uri ...).
 * Returns null when the data is not Metadata-shaped.
 */
export function decodeMetaplexMetadata(
  data: Uint8Array,
): { updateAuthority: string; name: string; symbol: string; uri: string } | null {
  try {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (buf[0] !== 4) return null; // Key::MetadataV1
    const updateAuthority = new PublicKey(buf.subarray(1, 33)).toBase58();
    let off = 1 + 32 + 32;
    const read = () => {
      const len = buf.readUInt32LE(off);
      off += 4;
      if (len > 1024 || off + len > buf.length) throw new Error("bad string");
      const s = buf.subarray(off, off + len).toString("utf8");
      off += len;
      return s.replace(/\0+$/g, "").trim();
    };
    const name = read();
    const symbol = read();
    const uri = read();
    return { updateAuthority, name, symbol, uri };
  } catch {
    return null;
  }
}
