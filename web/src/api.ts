import { actionCreators, type Action } from "@near-wallet-selector/core";
import { rpc, view, type FtMetadata } from "../../shared/near";
import { RefRouter } from "../../shared/ref";
import type { Config, Order, OrderRequest, StorageBalance, TokenBalance } from "../../shared/types";
import { CONTRACT_ID, NET, ONE_YOCTO, RPC_URL, TGAS } from "./config";

export const router = new RefRouter(RPC_URL, NET.refId, [...NET.hubs]);

export interface Token extends FtMetadata {
  id: string;
  /** Display symbol: wNEAR is shown as NEAR (wrapped automatically). */
  label: string;
}

export interface Tx {
  receiverId: string;
  actions: Action[];
}

const rx = <T,>(method: string, args: Record<string, unknown> = {}) => view<T>(RPC_URL, CONTRACT_ID, method, args);

export const getConfig = () => rx<Config>("get_config");
export const getTokenIds = () => rx<string[]>("get_tokens");
export const getAccountOrders = (account_id: string) => rx<Order[]>("get_account_orders", { account_id });
export const getBalances = (account_id: string) => rx<TokenBalance[]>("get_balances", { account_id });
export const getStorage = (account_id: string) => rx<StorageBalance | null>("storage_balance_of", { account_id });

export async function getAllOrders(): Promise<Order[]> {
  const all: Order[] = [];
  for (let from = 0; ; from += 100) {
    const page = await rx<Order[]>("get_orders", { from_index: from, limit: 100 });
    all.push(...page);
    if (page.length < 100) return all;
  }
}

// wrap.near has no icon in its metadata; show the NEAR mark instead.
const NEAR_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#fff"/>' +
      '<g transform="translate(4 4)"><path fill="#000" d="M16.4 4.9l-3.3 4.9c-.2.3.2.7.5.4l3.2-2.8c.1-.1.3 0 .3.1v8.9c0 .2-.2.2-.3.1L7.1 5.3C6.8 4.9 6.3 4.6 5.8 4.6h-.3C4.7 4.6 4 5.3 4 6.1v11.8c0 .8.7 1.5 1.5 1.5.5 0 1-.3 1.3-.7l3.3-4.9c.2-.3-.2-.7-.5-.4l-3.2 2.8c-.1.1-.3 0-.3-.1V7.2c0-.2.2-.2.3-.1l9.7 11.6c.3.4.8.6 1.3.6h.3c.8 0 1.5-.7 1.5-1.5V6.1c0-.8-.7-1.5-1.5-1.5-.5 0-1 .3-1.3.7z"/></g></svg>',
  );

const metaCache = new Map<string, Promise<Token>>();
export function getToken(id: string): Promise<Token> {
  if (!metaCache.has(id)) {
    metaCache.set(
      id,
      view<FtMetadata>(RPC_URL, id, "ft_metadata")
        .then((m) =>
          id === NET.wrapNear
            ? { ...m, id, label: "NEAR", icon: m.icon || NEAR_ICON }
            : { ...m, id, label: m.symbol },
        )
        .catch((e) => {
          metaCache.delete(id);
          throw e;
        }),
    );
  }
  return metaCache.get(id)!;
}

export const ftBalance = (token: string, account_id: string) =>
  view<string>(RPC_URL, token, "ft_balance_of", { account_id }).then(BigInt);

export const ftStorage = (token: string, account_id: string) =>
  view<StorageBalance | null>(RPC_URL, token, "storage_balance_of", { account_id }).catch(() => null);

async function ftStorageMin(token: string): Promise<bigint> {
  try {
    const b = await view<{ min: string }>(RPC_URL, token, "storage_balance_bounds");
    return BigInt(b.min);
  } catch {
    return 1_250_000_000_000_000_000_000n;
  }
}

export async function nearBalance(account_id: string): Promise<bigint> {
  try {
    const acc = await rpc<{ amount: string; storage_usage: number }>(RPC_URL, "query", {
      request_type: "view_account",
      finality: "final",
      account_id,
    });
    // Amount minus what's locked for storage.
    const free = BigInt(acc.amount) - BigInt(acc.storage_usage) * 10_000_000_000_000_000_000n;
    return free > 0n ? free : 0n;
  } catch {
    return 0n;
  }
}

export interface CatalogEntry {
  id: string;
  symbol: string;
}

type IndexerPrices = Record<string, { price: string; symbol: string }>;
let indexerPromise: Promise<IndexerPrices> | null = null;
const indexer = () =>
  (indexerPromise ??= fetch("https://indexer.ref.finance/list-token-price")
    .then((r) => r.json() as Promise<IndexerPrices>)
    .catch(() => ({})));

/** USD prices from Ref's indexer. Best effort — the app works without them. */
export const getUsdPrices = (): Promise<Record<string, number>> =>
  indexer().then((j) => Object.fromEntries(Object.entries(j).map(([k, v]) => [k, Number(v.price)])));

/** Every token Ref knows about — used to find tokens that aren't listed yet. */
export const getCatalog = (): Promise<CatalogEntry[]> =>
  indexer().then((j) =>
    Object.entries(j)
      // Some launchpad tokens have no symbol in the indexer: derive one from the contract ID.
      .map(([id, v]) => ({ id, symbol: v.symbol || id.split(".")[0].replace(/-\d+$/, "").toUpperCase() }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
  );

// ------------------------------------------------------------ transactions

const fc = (method: string, args: object, tgas: bigint, deposit: bigint) =>
  actionCreators.functionCall(method, args, tgas * TGAS, deposit);

/** Register `account` on a token contract if it isn't already. */
export async function ensureTokenStorage(token: string, account: string): Promise<Tx | null> {
  if (await ftStorage(token, account)) return null;
  return {
    receiverId: token,
    actions: [fc("storage_deposit", { account_id: account, registration_only: true }, 10n, await ftStorageMin(token))],
  };
}

export async function buildPlaceOrderTxs(
  account: string,
  config: Config,
  tokenIn: string,
  tokenOut: string,
  amount: bigint,
  request: OrderRequest,
): Promise<Tx[]> {
  const txs: Tx[] = [];

  // 1. readersEXIT storage (refundable NEAR deposit).
  const storage = await getStorage(account);
  const orderStorage = BigInt(config.order_storage);
  let need = 0n;
  if (!storage) need = BigInt(config.min_account_storage) + orderStorage;
  else if (BigInt(storage.available) < orderStorage) need = orderStorage - BigInt(storage.available);
  if (need > 0n) {
    txs.push({ receiverId: CONTRACT_ID, actions: [fc("storage_deposit", {}, 10n, need)] });
  }

  // 2. Make sure proceeds can be withdrawn later.
  const outReg = await ensureTokenStorage(tokenOut, account);
  if (outReg) txs.push(outReg);

  // 3. Wrap NEAR if needed, then deposit the order.
  const inActions: Action[] = [];
  if (tokenIn === NET.wrapNear) {
    const wrapped = (await ftStorage(tokenIn, account)) ? await ftBalance(tokenIn, account) : 0n;
    if (wrapped < amount) {
      if (!(await ftStorage(tokenIn, account))) {
        inActions.push(fc("storage_deposit", { account_id: account, registration_only: true }, 10n, await ftStorageMin(tokenIn)));
      }
      inActions.push(fc("near_deposit", {}, 10n, amount - wrapped));
    }
  }
  inActions.push(
    fc(
      "ft_transfer_call",
      { receiver_id: CONTRACT_ID, amount: amount.toString(), msg: JSON.stringify(request) },
      250n,
      ONE_YOCTO,
    ),
  );
  txs.push({ receiverId: tokenIn, actions: inActions });
  return txs;
}

export function buildCancelTx(order: Order): Tx {
  return {
    receiverId: CONTRACT_ID,
    actions: [
      fc("cancel", { order_id: order.id }, 20n, ONE_YOCTO),
      fc("withdraw", { token_id: order.token_in }, 250n, ONE_YOCTO),
    ],
  };
}

export async function buildClaimTxs(account: string, tokens: string[]): Promise<Tx[]> {
  const txs: Tx[] = [];
  for (const token of tokens) {
    const reg = await ensureTokenStorage(token, account);
    if (reg) txs.push(reg);
  }
  for (const token of tokens) {
    txs.push({ receiverId: CONTRACT_ID, actions: [fc("withdraw", { token_id: token }, 250n, ONE_YOCTO)] });
  }
  return txs;
}

/** Ref storage the contract needs per newly listed token (must match the contract). */
const REF_STORAGE_PER_TOKEN = 5_000_000_000_000_000_000_000n; // 0.005 NEAR

/** Permissionless listing: pays the token's storage + Ref storage for the contract. */
export async function buildListTokenTx(tokenId: string): Promise<Tx> {
  const tokenStorage = await ftStorageMin(tokenId);
  return {
    receiverId: CONTRACT_ID,
    actions: [
      fc(
        "list_token",
        { token_id: tokenId, token_storage: tokenStorage.toString() },
        120n,
        tokenStorage + REF_STORAGE_PER_TOKEN,
      ),
    ],
  };
}

export const LISTING_COST_NEAR = "~0.0063";

export function buildUnwrapTx(amount: bigint): Tx {
  return { receiverId: NET.wrapNear, actions: [fc("near_withdraw", { amount: amount.toString() }, 10n, ONE_YOCTO)] };
}
