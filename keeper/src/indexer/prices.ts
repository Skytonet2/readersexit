// USD valuation for fills: Ref's price feed (refreshed every minute) + token decimals.

import { view } from "../../../shared/near";

const PRICE_TTL_MS = 60_000;
let prices: Record<string, number> = {};
let pricesAt = 0;
const decimals = new Map<string, number>();

async function refreshPrices(): Promise<void> {
  if (Date.now() - pricesAt < PRICE_TTL_MS) return;
  try {
    const res = await fetch("https://indexer.ref.finance/list-token-price", { signal: AbortSignal.timeout(15_000) });
    const json = (await res.json()) as Record<string, { price: string }>;
    prices = Object.fromEntries(Object.entries(json).map(([id, v]) => [id, Number(v.price)]));
    pricesAt = Date.now();
  } catch {
    // Keep the last good prices; valuation just uses what we have.
  }
}

async function tokenDecimals(rpcUrl: string, token: string): Promise<number | null> {
  if (!decimals.has(token)) {
    try {
      decimals.set(token, (await view<{ decimals: number }>(rpcUrl, token, "ft_metadata")).decimals);
    } catch {
      return null;
    }
  }
  return decimals.get(token)!;
}

/** USD value of a raw token amount, or null if the token has no price. */
export async function usdValue(rpcUrl: string, token: string, raw: string | bigint): Promise<number | null> {
  await refreshPrices();
  const price = prices[token];
  const dec = await tokenDecimals(rpcUrl, token);
  if (!price || dec === null) return null;
  // Split to keep precision for 24-decimal tokens before converting to float.
  const amount = BigInt(raw);
  const base = 10n ** BigInt(dec);
  return (Number(amount / base) + Number(amount % base) / Number(base)) * price;
}
