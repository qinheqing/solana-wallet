/**
 * Single re-export surface for @solwallet/core + the web3.js primitives the
 * UI needs directly (PublicKey/Keypair). Keeps imports short across modules.
 */
export * from "@solwallet/core";
export { PublicKey, Keypair } from "@solana/web3.js";
