import { useEffect, useMemo, useState } from "react";
import { parseUnits, priceOf, formatUnits } from "../../../shared/near";
import type { Quote } from "../../../shared/ref";
import type { Config, OrderRequest } from "../../../shared/types";
import {
  buildListTokenTx,
  buildPlaceOrderTxs,
  ftBalance,
  ftStorage,
  LISTING_COST_NEAR,
  nearBalance,
  router,
  type CatalogEntry,
  type Token,
} from "../api";
import { NEAR_GAS_RESERVE, NET } from "../config";
import { fmtAmount, fmtNum, fmtPriceInput, fmtUsd, minOutAt, orient, defaultBase, type Base } from "../pricing";
import { storedReferrer } from "../referral";
import { useWallet } from "../wallet";
import { TokenSelect } from "./TokenSelect";

type Mode = "limit" | "dca";

const EXPIRIES = [
  { label: "Never", sec: 0 },
  { label: "1 day", sec: 86400 },
  { label: "7 days", sec: 7 * 86400 },
  { label: "30 days", sec: 30 * 86400 },
];
const INTERVAL_UNITS = [
  { label: "minutes", sec: 60 },
  { label: "hours", sec: 3600 },
  { label: "days", sec: 86400 },
];
// Price moves in the user's favour: sells nudge up, buys nudge down.
const SELL_NUDGES = [0, 5, 10, 25, 50, 100];
const BUY_NUDGES = [0, 5, 10, 25, 50, 75];
// DCA price-guard presets, relative to market.
const GUARD_STEPS = [10, 25, 50];
// Must match the keeper's MAX_IMPACT_BPS: DCA slices above it are skipped.
const DCA_MAX_IMPACT_BPS = 1000;

export function TradePanel({
  tokens,
  catalog,
  listed,
  config,
  tokenIn,
  tokenOut,
  onPair,
  usd,
  onPlaced,
  onMarket,
}: {
  tokens: Token[];
  catalog: CatalogEntry[];
  listed: Set<string>;
  config: Config | null;
  tokenIn?: Token;
  tokenOut?: Token;
  onPair: (tokenIn: string, tokenOut: string) => void;
  usd: Record<string, number>;
  onPlaced: () => void;
  onMarket: (quote: Quote | null, outPerIn: number) => void;
}) {
  const { accountId, signIn, send } = useWallet();
  const [mode, setMode] = useState<Mode>("limit");
  const [amountStr, setAmountStr] = useState("");
  const [priceStr, setPriceStr] = useState("");
  const [base, setBase] = useState<Base>("out");
  const [expiry, setExpiry] = useState(0);
  const [buys, setBuys] = useState("10");
  const [intervalVal, setIntervalVal] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState(3600);
  const [guardStr, setGuardStr] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const decIn = tokenIn?.decimals ?? 24;
  const decOut = tokenOut?.decimals ?? 24;
  const amountIn = parseUnits(amountStr, decIn);
  const nBuys = Math.max(0, Math.floor(Number(buys) || 0));
  const perSwap = nBuys > 0 ? amountIn / BigInt(nBuys) : 0n;
  const intervalSec = Math.floor((Number(intervalVal) || 0) * intervalUnit);

  const pricedToken = base === "in" ? tokenIn : tokenOut;
  const quoteToken = base === "in" ? tokenOut : tokenIn;

  // Reset orientation/price on pair change.
  useEffect(() => {
    if (tokenIn && tokenOut) setBase(defaultBase(tokenIn.id, tokenOut.id));
    setPriceStr("");
    setGuardStr("");
  }, [tokenIn?.id, tokenOut?.id]);

  // Wallet balance of the input token (NEAR counts native + wNEAR).
  useEffect(() => {
    setBalance(null);
    if (!accountId || !tokenIn) return;
    let live = true;
    (async () => {
      const registered = await ftStorage(tokenIn.id, accountId);
      let bal = registered ? await ftBalance(tokenIn.id, accountId) : 0n;
      if (tokenIn.id === NET.wrapNear) {
        const native = await nearBalance(accountId);
        bal += native > NEAR_GAS_RESERVE ? native - NEAR_GAS_RESERVE : 0n;
      }
      if (live) setBalance(bal);
    })().catch(() => live && setBalance(null));
    return () => {
      live = false;
    };
  }, [accountId, tokenIn?.id]);

  // Market quote (debounced). DCA quotes a single slice.
  const quoteAmount = mode === "dca" && perSwap > 0n ? perSwap : amountIn > 0n ? amountIn : 10n ** BigInt(decIn);
  useEffect(() => {
    if (!tokenIn || !tokenOut) return;
    let live = true;
    setQuoting(true);
    const t = setTimeout(() => {
      router
        .quote(tokenIn.id, tokenOut.id, quoteAmount)
        .then((q) => live && setQuote(q))
        .catch(() => live && setQuote(null))
        .finally(() => live && setQuoting(false));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tokenIn?.id, tokenOut?.id, quoteAmount.toString()]);

  const marketOutPerIn = quote ? priceOf(quoteAmount, quote.amountOut, decIn, decOut) : 0;
  const marketDisplay = orient(marketOutPerIn, base);
  useEffect(() => onMarket(quote, marketOutPerIn), [quote]);

  const limitMinOut = minOutAt(amountIn, priceStr, base, decIn, decOut);
  const limitOutPerIn = amountIn > 0n && limitMinOut > 0n ? priceOf(amountIn, limitMinOut, decIn, decOut) : 0;
  const limitDisplay = orient(limitOutPerIn, base);
  // Distance from market in displayed terms; `favorable` = better than market for the user.
  const vsMarket = marketDisplay > 0 && limitDisplay > 0 ? (limitDisplay / marketDisplay - 1) * 100 : null;
  const favorable = vsMarket !== null && (base === "in" ? vsMarket >= 0 : vsMarket <= 0);
  const guardMinOut = minOutAt(perSwap, guardStr, base, decIn, decOut);
  const betterSign = base === "in" ? "+" : "−";
  const nudges = base === "in" ? SELL_NUDGES : BUY_NUDGES;

  const nudge = (pct: number) => {
    if (!marketDisplay) return;
    setPriceStr(fmtPriceInput(marketDisplay * (1 + ((base === "in" ? 1 : -1) * pct) / 100)));
  };

  const error = useMemo(() => {
    if (!tokenIn || !tokenOut) return "Pick a pair";
    if (amountIn === 0n) return "Enter an amount";
    if (balance !== null && amountIn > balance) return `Insufficient ${tokenIn.label}`;
    if (mode === "limit") {
      if (limitMinOut === 0n) return "Set a price";
    } else {
      if (nBuys < 2) return "At least 2 buys";
      if (perSwap === 0n) return "Amount too small";
      if (intervalSec < 60) return "Interval must be ≥ 1 minute";
      // The keeper skips slices above this impact, so the order would never fill.
      if (quote && quote.priceImpactBps > DCA_MAX_IMPACT_BPS) return "Slices too big for the pool — add more buys";
    }
    if (!quote && !quoting) return "No safe route for this pair";
    return null;
  }, [tokenIn, tokenOut, amountIn, balance, mode, limitMinOut, nBuys, perSwap, intervalSec, quote, quoting]);

  const impactPct = quote ? quote.priceImpactBps / 100 : 0;

  // Tokens in this pair that nobody has listed yet (e.g. brand-new launches).
  const unlisted = [tokenIn, tokenOut].filter((t): t is Token => !!t && !listed.has(t.id));

  async function listTokens() {
    if (!accountId) return signIn();
    setBusy(true);
    setMsg(null);
    try {
      await send(await Promise.all(unlisted.map((t) => buildListTokenTx(t.id))));
      setMsg({ kind: "ok", text: `Listing ${unlisted.map((t) => t.label).join(" + ")}… ready in a few seconds.` });
      onPlaced();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message || "Listing failed" });
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!accountId) return signIn();
    if (unlisted.length) return listTokens();
    if (!config || !tokenIn || !tokenOut || error) return;
    setBusy(true);
    setMsg(null);
    try {
      const deposit = mode === "dca" ? perSwap * BigInt(nBuys) : amountIn;
      const request: OrderRequest =
        mode === "limit"
          ? {
              type: "limit",
              token_out: tokenOut.id,
              min_amount_out: limitMinOut.toString(),
              expires_at_sec: expiry ? Math.floor(Date.now() / 1000) + expiry : null,
            }
          : {
              type: "dca",
              token_out: tokenOut.id,
              amount_per_swap: perSwap.toString(),
              interval_sec: intervalSec,
              min_out_per_swap: guardMinOut > 0n ? guardMinOut.toString() : null,
              start_at_sec: null,
            };
      const txs = await buildPlaceOrderTxs(accountId, config, tokenIn.id, tokenOut.id, deposit, request, storedReferrer());
      await send(txs);
      setMsg({ kind: "ok", text: mode === "limit" ? "Limit order placed. Your exit is set." : "DCA plan started." });
      setAmountStr("");
      onPlaced();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message || "Transaction failed" });
    } finally {
      setBusy(false);
    }
  }

  const flipPair = () => tokenIn && tokenOut && onPair(tokenOut.id, tokenIn.id);
  const usdIn = tokenIn && usd[tokenIn.id] ? Number(formatUnits(amountIn, decIn, 8).replace(/,/g, "")) * usd[tokenIn.id] : 0;

  return (
    <section className="card trade">
      <div className="tabs" role="tablist">
        {(["limit", "dca"] as Mode[]).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
            {m === "limit" ? "Limit" : "DCA"}
          </button>
        ))}
      </div>

      <div className="field">
        <div className="field__label">
          <span>{mode === "dca" ? "Total to spend" : "You sell"}</span>
          {balance !== null && tokenIn && (
            <button className="link" onClick={() => setAmountStr(formatUnits(balance, decIn, decIn).replace(/,/g, ""))}>
              Balance: {fmtAmount(balance, decIn)}
            </button>
          )}
        </div>
        <div className="field__row">
          <input inputMode="decimal" placeholder="0.0" value={amountStr} onChange={(e) => setAmountStr(e.target.value.replace(",", "."))} />
          <TokenSelect tokens={tokens} catalog={catalog} listed={listed} value={tokenIn} exclude={tokenOut?.id} onChange={(id) => onPair(id, tokenOut?.id ?? "")} />
        </div>
        <div className="field__foot">{fmtUsd(usdIn)}</div>
      </div>

      <button className="flip" onClick={flipPair} aria-label="Swap direction">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="M5 2v11m0 0-3-3m3 3 3-3M11 14V3m0 0-3 3m3-3 3 3" stroke="currentColor" strokeWidth="1.6" fill="none" />
        </svg>
      </button>

      <div className="field">
        <div className="field__label">
          <span>{mode === "dca" ? "You get per buy (est.)" : "You buy (at least)"}</span>
        </div>
        <div className="field__row">
          <div className="field__estimate">
            {mode === "limit"
              ? limitMinOut > 0n
                ? fmtAmount(limitMinOut, decOut)
                : "—"
              : quote
                ? `~${fmtAmount(quote.amountOut, decOut)}`
                : "—"}
          </div>
          <TokenSelect tokens={tokens} catalog={catalog} listed={listed} value={tokenOut} exclude={tokenIn?.id} onChange={(id) => onPair(tokenIn?.id ?? "", id)} />
        </div>
      </div>

      {mode === "limit" ? (
        <div className="field">
          <div className="field__label">
            <span>
              Limit price · 1 {pricedToken?.label} in {quoteToken?.label}
            </span>
            <button className="link" onClick={() => setBase(base === "in" ? "out" : "in")}>
              flip ⇄
            </button>
          </div>
          <div className="field__row">
            <input inputMode="decimal" placeholder={marketDisplay ? fmtPriceInput(marketDisplay) : "0.0"} value={priceStr} onChange={(e) => setPriceStr(e.target.value.replace(",", "."))} />
          </div>
          <div className="chips">
            {nudges.map((p) => (
              <button key={p} className="chip" disabled={!marketOutPerIn} onClick={() => nudge(p)}>
                {p === 0 ? "Market" : `${betterSign}${p}%`}
              </button>
            ))}
          </div>
          <div className="row-between small">
            <span className="muted">Expires</span>
            <div className="seg">
              {EXPIRIES.map((e) => (
                <button key={e.sec} className={expiry === e.sec ? "active" : ""} onClick={() => setExpiry(e.sec)}>
                  {e.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="field">
          <div className="grid-2">
            <label>
              <span className="field__label">Number of buys</span>
              <input inputMode="numeric" value={buys} onChange={(e) => setBuys(e.target.value.replace(/\D/g, ""))} />
            </label>
            <label>
              <span className="field__label">Every</span>
              <div className="field__row compact">
                <input inputMode="decimal" value={intervalVal} onChange={(e) => setIntervalVal(e.target.value)} />
                <select value={intervalUnit} onChange={(e) => setIntervalUnit(Number(e.target.value))}>
                  {INTERVAL_UNITS.map((u) => (
                    <option key={u.sec} value={u.sec}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          </div>
          <label>
            <span className="field__label">
              {base === "out" ? "Max buy price" : "Min sell price"} (optional) · 1 {pricedToken?.label} in {quoteToken?.label}
            </span>
            <input inputMode="decimal" placeholder="No limit" value={guardStr} onChange={(e) => setGuardStr(e.target.value.replace(",", "."))} />
          </label>
          <div className="chips">
            {GUARD_STEPS.map((p) => (
              <button
                key={p}
                className="chip"
                disabled={!marketDisplay}
                // Buying: cap how far the price may rise. Selling: floor how far it may fall.
                onClick={() => setGuardStr(fmtPriceInput(marketDisplay * (base === "out" ? 1 + p / 100 : 1 - p / 100)))}
              >
                {base === "out" ? "+" : "−"}
                {p}%
              </button>
            ))}
            <button className="chip" onClick={() => setGuardStr("")}>
              No limit
            </button>
          </div>
          {!guardStr && (
            <p className="note">
              No {base === "out" ? "max" : "min"} price: each buy fills at whatever the market is, and slippage is
              set by the keeper. A limit protects you if the price spikes or someone front-runs a buy.
            </p>
          )}
        </div>
      )}

      <dl className="summary">
        <div>
          <dt>Market</dt>
          <dd>
            {quoting && !quote ? (
              <span className="muted">indexing Ref pools…</span>
            ) : quote ? (
              <>
                1 {pricedToken?.label} = {fmtNum(marketDisplay)} {quoteToken?.label}
                <span className="route" title={quote.path.join(" → ")}>
                  {quote.path.length > 2 ? "2-hop" : "direct"}
                </span>
              </>
            ) : (
              <span className="muted" title="Pools charging over 1% fee are ignored">
                no safe route
              </span>
            )}
          </dd>
        </div>
        {quote && (
          <>
            <div>
              <dt>{mode === "dca" ? "Price impact / buy" : "Price impact at market"}</dt>
              <dd className={impactPct >= 15 ? "bad" : impactPct >= 5 ? "down" : ""}>{impactPct.toFixed(2)}%</dd>
            </div>
            <div>
              <dt>Pool fee</dt>
              <dd>{quote.maxPoolFeeBps / 100}%</dd>
            </div>
            {impactPct >= 5 && (
              <p className={`note ${impactPct >= 15 ? "note--bad" : ""}`}>
                {mode === "dca"
                  ? "This pool is thin for your buy size — each buy moves the price a lot. Use more, smaller buys."
                  : "This pool is thin for your size — a market-price fill would move the price a lot. Your limit price still protects you."}
              </p>
            )}
          </>
        )}
        {mode === "limit" ? (
          <>
            <div>
              <dt>vs market</dt>
              <dd className={vsMarket === null ? "" : favorable ? "up" : "down"}>
                {vsMarket === null ? "—" : `${Math.abs(vsMarket).toFixed(2)}% ${vsMarket >= 0 ? "above" : "below"}`}
              </dd>
            </div>
            {vsMarket !== null && !favorable && (
              <p className="note">Your price is already reachable — this will fill on the next keeper pass, at your price or better.</p>
            )}
          </>
        ) : (
          <>
            <div>
              <dt>Per buy</dt>
              <dd>
                {perSwap > 0n ? fmtAmount(perSwap, decIn) : "—"} {tokenIn?.label}
              </dd>
            </div>
            <div>
              <dt>Runs for</dt>
              <dd>{nBuys >= 2 && intervalSec >= 60 ? `~${fmtDurationLong((nBuys - 1) * intervalSec)}` : "—"}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Protocol fee</dt>
          <dd>{config ? `${config.fee_bps / 100}%` : "—"}</dd>
        </div>
      </dl>

      {unlisted.length > 0 && (
        <p className="note">
          {unlisted.map((t) => t.label).join(" + ")} {unlisted.length > 1 ? "aren't" : "isn't"} on readersEXIT yet. Anyone can list
          a token — one-time {LISTING_COST_NEAR} NEAR each for storage, refunded if it fails.
        </p>
      )}
      <button className="cta" disabled={busy || (!!accountId && !unlisted.length && !!error) || !config} onClick={submit}>
        {!accountId
          ? "Connect wallet"
          : busy
            ? "Confirm in wallet…"
            : unlisted.length
              ? `List ${unlisted.map((t) => t.label).join(" + ")} to trade`
              : (error ?? (mode === "limit" ? "Place limit order" : "Start DCA"))}
      </button>
      {msg && <p className={`msg msg--${msg.kind}`}>{msg.text}</p>}
      <p className="fine">
        First order adds a refundable storage deposit (~0.06 NEAR). NEAR is wrapped automatically. Orders execute on Ref
        Finance; the contract enforces your minimum on-chain.
      </p>
    </section>
  );
}

function fmtDurationLong(sec: number): string {
  if (sec >= 86400) return `${+(sec / 86400).toFixed(1)} days`;
  if (sec >= 3600) return `${+(sec / 3600).toFixed(1)} hours`;
  return `${Math.round(sec / 60)} minutes`;
}
