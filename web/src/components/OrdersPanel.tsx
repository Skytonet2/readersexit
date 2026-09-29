import { useState } from "react";
import { priceOf } from "../../../shared/near";
import type { Order } from "../../../shared/types";
import { buildCancelTx, type Token } from "../api";
import { defaultBase, fmtAmount, fmtDuration, fmtNum, orient } from "../pricing";
import { useWallet } from "../wallet";
import { TokenIcon } from "./TokenSelect";

export function OrdersPanel({
  orders,
  tokenMap,
  onChanged,
}: {
  orders: Order[];
  tokenMap: Record<string, Token>;
  onChanged: () => void;
}) {
  const { send } = useWallet();
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = Math.floor(Date.now() / 1000);

  async function cancel(order: Order) {
    setBusy(order.id);
    setErr(null);
    try {
      await send([buildCancelTx(order)]);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <header className="card__head">
        <h2>Your orders</h2>
        <span className="count">{orders.length}</span>
      </header>
      {orders.length === 0 ? (
        <p className="empty">No open orders. Set an exit above.</p>
      ) : (
        <div className="orders">
          {orders.map((o) => {
            const tIn = tokenMap[o.token_in];
            const tOut = tokenMap[o.token_out];
            if (!tIn || !tOut) return null;
            const base = defaultBase(o.token_in, o.token_out);
            const priced = base === "in" ? tIn : tOut;
            const quote = base === "in" ? tOut : tIn;
            const spent = BigInt(o.amount_in) - BigInt(o.remaining_in);
            const pct = Number((spent * 1000n) / BigInt(o.amount_in)) / 10;
            let detail: string;
            if (o.kind.type === "limit") {
              const p = orient(priceOf(BigInt(o.amount_in), BigInt(o.kind.min_amount_out), tIn.decimals, tOut.decimals), base);
              const exp = o.kind.expires_at_sec;
              detail = `@ ${fmtNum(p)} ${quote.label}/${priced.label}` + (exp ? ` · expires in ${fmtDuration(exp - now)}` : "");
            } else {
              const per = BigInt(o.kind.amount_per_swap);
              const total = Number((BigInt(o.amount_in) + per - 1n) / per);
              const next = o.kind.next_exec_at_sec - now;
              detail = `${o.kind.swaps_done}/${total} buys · every ${fmtDuration(o.kind.interval_sec)} · next ${next > 0 ? `in ${fmtDuration(next)}` : "due"}`;
            }
            return (
              <article key={o.id} className="order">
                <div className="order__pair">
                  <span className={`badge badge--${o.kind.type}`}>{o.kind.type === "limit" ? "LIMIT" : "DCA"}</span>
                  <TokenIcon token={tIn} size={18} />
                  <span>{tIn.label}</span>
                  <span className="muted">→</span>
                  <TokenIcon token={tOut} size={18} />
                  <span>{tOut.label}</span>
                  <span className="muted order__id">#{o.id}</span>
                </div>
                <div className="order__detail muted small">{detail}</div>
                <div className="progress" aria-label={`${pct}% filled`}>
                  <span style={{ width: `${pct}%` }} />
                </div>
                <div className="order__nums small">
                  <span>
                    {fmtAmount(o.remaining_in, tIn.decimals)} / {fmtAmount(o.amount_in, tIn.decimals)} {tIn.label} left
                  </span>
                  <span>
                    got {fmtAmount(o.filled_out, tOut.decimals)} {tOut.label}
                  </span>
                </div>
                <div className="order__actions">
                  <span className={`status status--${o.status.toLowerCase()}`}>{o.status}</span>
                  <button className="btn-ghost" disabled={o.status !== "Open" || busy === o.id} onClick={() => cancel(o)}>
                    {busy === o.id ? "…" : "Cancel & withdraw"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {err && <p className="msg msg--err">{err}</p>}
    </section>
  );
}
