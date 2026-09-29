import { NETWORKS, type NetworkId } from "../../shared/types";

export const NETWORK = (import.meta.env.VITE_NETWORK ?? "mainnet") as NetworkId;
export const NET = NETWORKS[NETWORK];
export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? NET.rpcUrl;
export const CONTRACT_ID: string =
  import.meta.env.VITE_CONTRACT_ID ?? (NETWORK === "mainnet" ? "readersexit.near" : "readersexit.testnet");

/** Used for browsing/quotes when the contract isn't reachable (e.g. before deploy). */
export const FALLBACK_TOKENS: string[] =
  NETWORK === "mainnet"
    ? [
        "wrap.near",
        "usdt.tether-token.near",
        "blackdragon.tkn.near",
        "ftv2.nekotoken.near",
        "token.lonkingnearbackto2024.near",
        "token.0xshitzu.near",
        "intel.tkn.near",
        "slush.tkn.near",
        "hat.tkn.near",
      ]
    : ["wrap.testnet"];

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
/** NEAR kept in the wallet for gas when wrapping. */
export const NEAR_GAS_RESERVE = 250_000_000_000_000_000_000_000n; // 0.25 NEAR
