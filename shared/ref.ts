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
}

const PAGE = 1000;

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

  /** Pools containing both tokens, deepest (by reserve of `a`) first. */
  poolsBetween(a: string, b: string, limit = 3): RefPool[] {
    return (this.byToken.get(a) ?? [])
      .filter((p) => p.token_account_ids.includes(b))
      .sort((x, y) => {
        const d = reserve(y, a) - reserve(x, a);
        return d > 0n ? 1 : d < 0n ? -1 : 0;
      })
      .slice(0, limit);
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
    const candidates: Promise<Quote>[] = [];

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
    const best = quotes.reduce<Quote | null>((b, q) => (!b || q.amountOut > b.amountOut ? q : b), null);
    return best && best.amountOut > 0n ? best : null;
  }
}

function reserve(pool: RefPool, token: string): bigint {
  const i = pool.token_account_ids.indexOf(token);
  return i < 0 ? 0n : BigInt(pool.amounts[i]);
}
