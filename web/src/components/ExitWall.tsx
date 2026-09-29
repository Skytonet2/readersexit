import { formatUnits, priceOf } from "../../../shared/near";
import type { Order } from "../../../shared/types";
import type { Token } from "../api";
import { baseAndQuote, fmtNum } from "../pricing";

interface Level {
  price: number;
  size: number;
  count: number;
}

/**
 * Public book of resting limit orders for the selected pair, priced as
 * 1 meme = P quote. Asks = people exiting the meme, bids = people buying the dip.
 */
export function ExitWall({
  orders,
  tokenIn,
  tokenOut,
  marketOutPerIn,
}: {
  orders: Order[];
  tokenIn?: Token;
  tokenOut?: Token;
  marketOutPerIn: number;
}) {
  if (!tokenIn || !tokenOut) return null;
  const [baseId] = baseAndQuote(tokenIn.id, tokenOut.id);
  const base = baseId === tokenIn.id ? tokenIn : tokenOut;
  const quote = baseId === tokenIn.id ? tokenOut : tokenIn;
  const human = (raw: string | bigint, dec: number) => Number(formatUnits(raw, dec, 8).replace(/,/g, ""));

  const asks = new Map<string, Level>();
  const bids = new Map<string, Level>();
  let dcaCount = 0;
  for (const o of orders) {
    const isAsk = o.token_in === base.id && o.token_out === quote.id;
    const isBid = o.token_in === quote.id && o.token_out === base.id;
    if (!isAsk && !isBid) continue;
    if (o.kind.type === "dca") {
      dcaCount++;
      continue;
    }
    const minOut = BigInt(o.kind.min_amount_out);
    const amtIn = BigInt(o.amount_in);
    const price = isAsk ? priceOf(amtIn, minOut, base.decimals, quote.decimals) : 1 / priceOf(amtIn, minOut, quote.decimals, base.decimals);
    const size = isAsk ? human(o.remaining_in, base.decimals) : human(minOut, base.decimals);
    const book = isAsk ? asks : bids;
    const key = fmtNum(price, 4);
    const lvl = book.get(key) ?? { price, size: 0, count: 0 };
    lvl.size += size;
    lvl.count++;
    book.set(key, lvl);
  }

  const askList = [...asks.values()].sort((a, b) => b.price - a.price).slice(-8);
  const bidList = [...bids.values()].sort((a, b) => b.price - a.price).slice(0, 8);
  const maxSize = Math.max(1e-30, ...askList.map((l) => l.size), ...bidList.map((l) => l.size));
  const market = baseId === tokenIn.id ? marketOutPerIn : marketOutPerIn > 0 ? 1 / marketOutPerIn : 0;

  const row = (l: Level, side: "ask" | "bid") => (
    <li key={side + l.price} className={`wall__row wall__row--${side}`}>
      <span className="wall__bar" style={{ width: `${(l.size / maxSize) * 100}%` }} />
      <span className="mono">{fmtNum(l.price)}</span>
      <span className="mono">{fmtNum(l.size, 4)}</span>
      <span className="muted">{l.count}</span>
    </li>
  );

  return (
    <section className="card">
      <header className="card__head">
        <h2>Exit wall</h2>
        <span className="muted small">
          {base.label}/{quote.label}
        </span>
      </header>
      <div className="wall__head small muted">
        <span>Price ({quote.label})</span>
        <span>Size ({base.label})</span>
        <span>#</span>
      </div>
      <ul className="wall">
        {askList.length === 0 && <li className="wall__empty muted small">No exits queued</li>}
        {askList.map((l) => row(l, "ask"))}
        <li className="wall__mid mono">{market ? fmtNum(market) : "—"} market</li>
        {bidList.map((l) => row(l, "bid"))}
        {bidList.length === 0 && <li className="wall__empty muted small">No dip bids queued</li>}
      </ul>
      {dcaCount > 0 && (
        <p className="muted small">
          + {dcaCount} active DCA plan{dcaCount > 1 ? "s" : ""} on this pair
        </p>
      )}
    </section>
  );
}
