// Mirrors the JSON types returned by the readersEXIT contract.

export type OrderKind =
  | { type: "limit"; min_amount_out: string; expires_at_sec: number | null }
  | {
      type: "dca";
      amount_per_swap: string;
      interval_sec: number;
      min_out_per_swap: string;
      next_exec_at_sec: number;
      swaps_done: number;
    };

export interface Order {
  id: number;
  owner_id: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  remaining_in: string;
  filled_out: string;
  kind: OrderKind;
  status: "Funding" | "Open" | "Executing";
  created_at_sec: number;
}

export interface Config {
  owner_id: string;
  ref_exchange_id: string;
  treasury_id: string;
  fee_bps: number;
  paused: boolean;
  next_order_id: number;
  open_orders: number;
  min_account_storage: string;
  order_storage: string;
  /** Share of the protocol fee paid to referrers (5000 = half). */
  referral_share_bps: number;
}

export interface StorageBalance {
  total: string;
  available: string;
}

export interface TokenBalance {
  token_id: string;
  balance: string;
}

export type OrderRequest =
  | { type: "limit"; token_out: string; min_amount_out: string; expires_at_sec: number | null }
  | {
      type: "dca";
      token_out: string;
      amount_per_swap: string;
      interval_sec: number;
      min_out_per_swap: string | null;
      start_at_sec: number | null;
    };

export const NETWORKS = {
  mainnet: {
    // Comma-separated: tried in order, rotating on rate limits.
    rpcUrl: "https://free.rpc.fastnear.com,https://rpc.intea.rs,https://rpc.mainnet.near.org",
    refId: "v2.ref-finance.near",
    wrapNear: "wrap.near",
    hubs: ["wrap.near", "usdt.tether-token.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"],
    explorer: "https://nearblocks.io",
  },
  testnet: {
    rpcUrl: "https://test.rpc.fastnear.com,https://rpc.testnet.near.org",
    refId: "ref-finance-101.testnet",
    wrapNear: "wrap.testnet",
    hubs: ["wrap.testnet"],
    explorer: "https://testnet.nearblocks.io",
  },
} as const;

export type NetworkId = keyof typeof NETWORKS;
