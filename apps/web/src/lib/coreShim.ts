/**
 * Single re-export surface for @sol-wallet/core + the web3.js primitives the
 * UI needs directly (PublicKey/Keypair). Keeps imports short across modules.
 */
export * from "@sol-wallet/core";
export { PublicKey, Keypair } from "@solana/web3.js";
