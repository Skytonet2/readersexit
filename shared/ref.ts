// Ref Finance pool index + best-route quoting, shared by the web app and keeper.
// Everything is read on-chain (get_pools / get_return), no indexer dependency.

import { view } from "./near";

export interface RefPool {
  id: number;
  pool_kind: string;
  token_account_ids: string[];
  amounts: string[];
  total_fee: number;
}

export interface RouteHop {
  pool_id: number;
  token_out: string;
}

export interface Quote {
  route: RouteHop[];
  path: string[];
  amountOut: bigint;
  /** Highest pool fee along the route, in bps. */
  maxPoolFeeBps: number;
  /**
   * Loss from pool depth alone, in bps: this trade's rate vs a tiny trade on the same
   * route (fees cancel out). 10000 = the pool can't absorb the trade at all.
   */
  priceImpactBps: number;
}

const PAGE = 1000;
/** Pools charging more than this are ignored (normal Ref pools: 1–30 bps; traps: 2000+). */
export const DEFAULT_MAX_POOL_FEE_BPS = 100;

export class RefRouter {
  private pools: RefPool[] = [];
  private byToken = new Map<string, RefPool[]>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private rpcUrl: string,
    private refId: string,
    private hubs: string[],
    private ttlMs = 10 * 60_000,
    private maxPoolFeeBps = DEFAULT_MAX_POOL_FEE_BPS,
  ) {}

  async load(force = false): Promise<void> {
    if (!force && this.pools.length && Date.now() - this.loadedAt < this.ttlMs) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const total = await view<number>(this.rpcUrl, this.refId, "get_number_of_pools");
      const pageCount = Math.ceil(total / PAGE);
      const pages: Omit<RefPool, "id">[][] = new Array(pageCount);
      // A few pages at a time keeps public RPCs from rate-limiting us.
      for (let start = 0; start < pageCount; start += 3) {
        await Promise.all(
          Array.from({ length: Math.min(3, pageCount - start) }, async (_, k) => {
            const i = start + k;
            pages[i] = await view<Omit<RefPool, "id">[]>(this.rpcUrl, this.refId, "get_pools", {
              from_index: i * PAGE,
              limit: PAGE,
            });
          }),
        );
      }
      const pools: RefPool[] = [];
      pages.forEach((page, p) =>
        page.forEach((pool, i) => {
          if (pool.amounts.every((a) => a !== "0")) pools.push({ ...pool, id: p * PAGE + i });
        }),
      );
      const byToken = new Map<string, RefPool[]>();
      for (const pool of pools) {
        for (const t of pool.token_account_ids) {
          if (!byToken.has(t)) byToken.set(t, []);
          byToken.get(t)!.push(pool);
        }
      }
      this.pools = pools;
      this.byToken = byToken;
      this.loadedAt = Date.now();
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /**
   * Candidate pools holding both tokens: the deepest by each side's reserve (a pool can
   * be deep in one token and nearly empty in the other). High-fee pools are excluded.
   */
  poolsBetween(a: string, b: string, limit = 3): RefPool[] {
    const pools = (this.byToken.get(a) ?? []).filter(
      (p) => p.token_account_ids.includes(b) && p.total_fee <= this.maxPoolFeeBps,
    );
    const deepest = (t: string) =>
      [...pools]
        .sort((x, y) => {
          const d = reserve(y, t) - reserve(x, t);
          return d > 0n ? 1 : d < 0n ? -1 : 0;
        })
        .slice(0, limit);
    return [...new Set([...deepest(a), ...deepest(b)])];
  }

  /** Output of a fixed route for `amountIn` (0 if any hop fails). */
  async quoteRoute(tokenIn: string, route: RouteHop[], amountIn: bigint): Promise<bigint> {
    let amount = amountIn;
    let token = tokenIn;
    for (const hop of route) {
      const pool = this.pools.find((p) => p.id === hop.pool_id);
      if (!pool || amount <= 0n) return 0n;
      amount = await this.getReturn(pool, token, amount, hop.token_out);
      token = hop.token_out;
    }
    return amount;
  }

  hasToken(token: string): boolean {
    return this.byToken.has(token);
  }

  private async getReturn(pool: RefPool, tokenIn: string, amountIn: bigint, tokenOut: string): Promise<bigint> {
    try {
      const out = await view<string>(this.rpcUrl, this.refId, "get_return", {
        pool_id: pool.id,
        token_in: tokenIn,
        amount_in: amountIn.toString(),
        token_out: tokenOut,
      });
      return BigInt(out);
    } catch {
      return 0n;
    }
  }

  /** Best route for amountIn among direct pools and 2-hop routes via hub tokens. */
  async quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote | null> {
    await this.load();
    if (amountIn <= 0n || tokenIn === tokenOut) return null;
    const candidates: Promise<Omit<Quote, "maxPoolFeeBps" | "priceImpactBps">>[] = [];

    for (const pool of this.poolsBetween(tokenIn, tokenOut)) {
      candidates.push(
        this.getReturn(pool, tokenIn, amountIn, tokenOut).then((amountOut) => ({
          route: [{ pool_id: pool.id, token_out: tokenOut }],
          path: [tokenIn, tokenOut],
          amountOut,
        })),
      );
    }

    for (const hub of this.hubs) {
      if (hub === tokenIn || hub === tokenOut) continue;
      const first = this.poolsBetween(tokenIn, hub, 2);
      const second = this.poolsBetween(hub, tokenOut, 2);
      for (const p1 of first) {
        const mid = this.getReturn(p1, tokenIn, amountIn, hub);
        for (const p2 of second) {
          candidates.push(
            mid.then(async (midOut) => ({
              route: [
                { pool_id: p1.id, token_out: hub },
                { pool_id: p2.id, token_out: tokenOut },
              ],
              path: [tokenIn, hub, tokenOut],
              amountOut: midOut > 0n ? await this.getReturn(p2, hub, midOut, tokenOut) : 0n,
            })),
          );
        }
      }
    }

    const quotes = await Promise.all(candidates);
    const best = quotes.reduce<(typeof quotes)[number] | null>((b, q) => (!b || q.amountOut > b.amountOut ? q : b), null);
    if (!best || best.amountOut <= 0n) return null;

    const maxPoolFeeBps = Math.max(...best.route.map((h) => this.pools.find((p) => p.id === h.pool_id)?.total_fee ?? 0));
    const probe = amountIn / 1000n > 0n ? amountIn / 1000n : 1n;
    const probeOut = await this.quoteRoute(tokenIn, best.route, probe);
    let priceImpactBps = 10_000;
    if (probeOut > 0n) {
      const ratioBps = (best.amountOut * probe * 10_000n) / (probeOut * amountIn);
      priceImpactBps = Math.max(0, Math.min(10_000, 10_000 - Number(ratioBps)));
    }
    return { ...best, maxPoolFeeBps, priceImpactBps };
  }
}

function reserve(pool: RefPool, token: string): bigint {
  const i = pool.token_account_ids.indexOf(token);
  return i < 0 ? 0n : BigInt(pool.amounts[i]);
}
