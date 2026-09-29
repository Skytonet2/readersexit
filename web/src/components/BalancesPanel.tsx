import { useState } from "react";
import { formatUnits } from "../../../shared/near";
import type { TokenBalance } from "../../../shared/types";
import { buildClaimTxs, buildUnwrapTx, type Token } from "../api";
import { fmtAmount, fmtUsd } from "../pricing";
import { useWallet } from "../wallet";
import { TokenIcon } from "./TokenSelect";

export function BalancesPanel({
  balances,
  wrapped,
  tokenMap,
  usd,
  onChanged,
}: {
  balances: TokenBalance[];
  wrapped: bigint;
  tokenMap: Record<string, Token>;
  usd: Record<string, number>;
  onChanged: () => void;
}) {
  const { accountId, send } = useWallet();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(build: () => Promise<Parameters<typeof send>[0]>) {
    if (!accountId) return;
    setBusy(true);
    setErr(null);
    try {
      await send(await build());
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const usdOf = (b: TokenBalance) => {
    const t = tokenMap[b.token_id];
    return t && usd[b.token_id] ? Number(formatUnits(b.balance, t.decimals, 8).replace(/,/g, "")) * usd[b.token_id] : 0;
  };
  const wnear = Object.values(tokenMap).find((t) => t.label === "NEAR");

  return (
    <section className="card">
      <header className="card__head">
        <h2>Claimable</h2>
        {balances.length > 1 && (
          <button className="btn-ghost" disabled={busy} onClick={() => run(() => buildClaimTxs(accountId!, balances.map((b) => b.token_id)))}>
            Claim all
          </button>
        )}
      </header>
      {balances.length === 0 ? (
        <p className="empty">Filled and cancelled orders land here.</p>
      ) : (
        <ul className="balances">
          {balances.map((b) => {
            const t = tokenMap[b.token_id];
            return (
              <li key={b.token_id}>
                <TokenIcon token={t} />
                <div className="balances__amt">
                  <strong>
                    {t ? fmtAmount(b.balance, t.decimals) : b.balance} {t?.label ?? b.token_id}
                  </strong>
                  <span className="muted small">{fmtUsd(usdOf(b))}</span>
                </div>
                <button className="btn" disabled={busy} onClick={() => run(() => buildClaimTxs(accountId!, [b.token_id]))}>
                  Claim
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {wrapped > 0n && wnear && (
        <div className="unwrap small">
          <span className="muted">
            {fmtAmount(wrapped, 24)} wNEAR in your wallet
          </span>
          <button className="link" disabled={busy} onClick={() => run(async () => [buildUnwrapTx(wrapped)])}>
            Unwrap to NEAR
          </button>
        </div>
      )}
      {err && <p className="msg msg--err">{err}</p>}
    </section>
  );
}
