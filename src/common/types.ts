// The values shared by the Guardian core and its screening adapters.
// Hex types describe expected values; they do not validate length, bytes or deployment identity.
// The caller owns configuration validity, and ABI decoding validates chain values where used.
// `lower` normalizes hexadecimal case for addresses and transaction keys without validating them.
//
// viem declares the same shapes, and these stay ours on purpose: a consumer names them without
// importing viem's types, and a viem major is then not a breaking change of this package's type
// surface, which `scripts/check-surface.ts` enforces. At run time the package needs viem, which the
// consumer installs as a peer dependency.

/**
 * A `0x`-prefixed hex string. This template type is not a runtime byte or length validator.
 */
export type Hex = `0x${string}`;

/** A value expected to contain exactly 32 bytes; the alias itself enforces only the hex prefix. */
export type Bytes32 = Hex;

/** A value expected to be a 20-byte lowercase address; the alias itself does not validate it. */
export type Address = Hex;

/** A value expected to be a transaction hash; the alias itself does not validate its length. */
export type TxHash = Hex;

/** A value expected to be `keccak256(MarketParams)`; the alias itself does not validate it. */
export type MarketId = Hex;

/** A contract address and the earliest block its history can contain. */
export interface ContractDeployment {
  readonly address: Address;
  readonly deploymentBlock: number;
}

/** Normalize hexadecimal case without changing the bytes or validating their format. */
export function lower(value: Hex): Hex {
  return `0x${value.slice(2).toLowerCase()}`;
}

/**
 * A block, by the three fields the algorithm compares. The hash is what pins a read and what the
 * registry re-derives with `blockhash`; the timestamp is what orders coverage, because the chain
 * cannot attest a block number to the registry.
 */
export interface BlockRef {
  readonly number: number;
  readonly hash: Bytes32;
  readonly timestamp: number;
}
