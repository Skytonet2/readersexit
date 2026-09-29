import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "../../../shared/near";
import { getToken, type Token } from "../api";
import { TokenIcon } from "../components/TokenSelect";
import { NET } from "../config";
import { num, shortAccount, timeAgo, usd } from "../format";
import { getHistory, getProfile, getReferrals, type HistoryRow, type Profile, type ReferralRow } from "../indexer";
import { referralLink } from "../referral";
import { Link } from "../router";
import { useWallet } from "../wallet";

/** Loads metadata for every token referenced by the rows (cached by getToken). */
function useTokens(ids: string[]) {
  const [map, setMap] = useState<Record<string, Token>>({});
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    Promise.allSettled(key.split(",").map(getToken)).then((res) =>
      setMap(Object.fromEntries(res.flatMap((r) => (r.status === "fulfilled" ? [[r.value.id, r.value]] : [])))),
    );
  }, [key]);
  return map;
}

function Amount({ raw, token, tokens }: { raw: unknown; token: unknown; tokens: Record<string, Token> }) {
  const t = tokens[String(token)];
  if (raw === undefined || raw === null) return null;
  return (
    <span className="amount">
      <span className="mono">{t ? formatUnits(String(raw), t.decimals, 4) : "…"}</span> <TokenIcon token={t} size={16} />
      {t?.label ?? shortAccount(String(token), 16)}
    </span>
  );
}

function describe(row: HistoryRow, tokens: Record<string, Token>, orderTokenIn: Map<number, string>) {
  const d = row.data;
  const id = row.order_id !== null ? `#${row.order_id}` : "";
  switch (row.event) {
    case "order_created": {
      const kind = (d.kind as { type: string } | undefined)?.type === "dca" ? "DCA" : "Limit";
      return (
        <>
          Placed {kind} {id}: <Amount raw={d.amount_in} token={d.token_in} tokens={tokens} /> →{" "}
          {tokens[String(d.token_out)]?.label ?? shortAccount(String(d.token_out), 16)}
        </>
      );
    }
    case "order_executed":
      return (
        <>
          Filled {id}: <Amount raw={d.amount_in} token={d.token_in} tokens={tokens} /> →{" "}
          <Amount raw={d.amount_out} token={d.token_out} tokens={tokens} />
        </>
      );
    case "order_completed":
      return <>Order {id} completed</>;
    case "order_cancelled":
    case "order_expired":
      return (
        <>
          {row.event === "order_cancelled" ? "Cancelled" : "Expired"} {id}, refunded{" "}
          <Amount raw={d.refunded} token={orderTokenIn.get(row.order_id ?? -1)} tokens={tokens} />
        </>
      );
    case "withdraw":
      return (
        <>
          Claimed <Amount raw={d.amount} token={d.token_id} tokens={tokens} />
        </>
      );
    case "withdraw_failed":
      return <>Claim failed (balance kept) — check token registration</>;
    case "token_listed":
      return <>Listed {tokens[String(d.token_id)]?.label ?? String(d.token_id)}</>;
    case "referral_set":
      return <>Joined via {String(d.referrer_id)}</>;
    case "order_execution_failed":
      return <>Fill attempt on {id} didn't go through (retried automatically)</>;
    case "order_funding_failed":
      return <>Order {id} couldn't be funded — tokens returned</>;
    default:
      return <>{row.event}</>;
  }
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <strong className="stat__value">{value}</strong>
      {hint && <span className="stat__hint">{hint}</span>}
    </div>
  );
}

export function ProfilePage({ account }: { account: string | null }) {
  const { accountId, signIn } = useWallet();
  const target = account ?? accountId;
  const isMe = !!accountId && target === accountId;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [more, setMore] = useState(false);
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setProfile(null);
    setHistory([]);
    setReferrals([]);
    setError(false);
    if (!target) return;
    getProfile(target).then(setProfile).catch(() => setError(true));
    getHistory(target)
      .then((rows) => {
        setHistory(rows);
        setMore(rows.length === 50);
      })
      .catch(() => setError(true));
    if (isMe) getReferrals(target).then(setReferrals).catch(() => {});
  }, [target, isMe]);

  const loadMore = useCallback(() => {
    if (!target || !history.length) return;
    getHistory(target, history[history.length - 1].ts).then((rows) => {
      setHistory((h) => [...h, ...rows]);
      setMore(rows.length === 50);
    });
  }, [target, history]);

  const tokenIds = history.flatMap((r) =>
    ["token_in", "token_out", "token_id"].map((k) => r.data[k]).filter((v): v is string => typeof v === "string"),
  );
  const tokens = useTokens(tokenIds);
  const orderTokenIn = new Map(
    history.filter((r) => r.event === "order_created" && r.order_id !== null).map((r) => [r.order_id!, String(r.data.token_in)]),
  );

  if (!target) {
    return (
      <main className="page page--narrow">
        <section className="card center">
          <h1>Your profile</h1>
          <p className="muted">Connect a wallet to see your trades, history and referral link.</p>
          <button className="cta cta--inline" onClick={signIn}>
            Connect wallet
          </button>
        </section>
      </main>
    );
  }

  const link = referralLink(target);

  return (
    <main className="page">
      <header className="page__head profile__head">
        <div>
          <h1>{shortAccount(target, 40)}</h1>
          <p className="muted">
            {profile?.first_seen ? `Trading since ${new Date(profile.first_seen).toLocaleDateString()}` : "No activity yet"}
            {profile?.referrer_id && <> · referred by {profile.referrer_id}</>}
          </p>
        </div>
        <a className="btn-ghost" href={`${NET.explorer}/address/${target}`} target="_blank" rel="noreferrer">
          Explorer ↗
        </a>
      </header>

      {error && <p className="note">Stats are temporarily unavailable. Your balances and open orders are on the Trade page.</p>}

      <section className="stats">
        <Stat label="Volume" value={usd(profile?.volume_usd)} />
        <Stat label="Fills" value={num(profile?.fills)} />
        <Stat label="Orders" value={num(profile?.orders)} />
        <Stat label="Fees paid" value={usd(profile?.fees_paid_usd)} />
        {profile?.campaign_rank && (
          <Stat label="Competition" value={`#${profile.campaign_rank.rank}`} hint={usd(profile.campaign_rank.volume_usd)} />
        )}
      </section>

      {isMe && (
        <section className="card referral">
          <header className="card__head">
            <h2>Invite & earn</h2>
            <span className="muted small">50% of the fee on every fill, forever</span>
          </header>
          <div className="referral__link">
            <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Your referral link" />
            <button
              className="btn"
              onClick={() => {
                navigator.clipboard?.writeText(link).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="stats stats--inline">
            <Stat label="Invited" value={num(profile?.referrals)} />
            <Stat label="Trading" value={num(profile?.referred_traders)} />
            <Stat label="Earned" value={usd(profile?.referral_earnings_usd)} />
          </div>
          <p className="fine">
            Rewards are paid by the contract into your Claimable balance on the{" "}
            <Link to="/trade">Trade page</Link>, in whatever token each fill paid out. A referral sticks to the first link a
            trader uses and can't be self-referred.
          </p>
          {referrals.length > 0 && (
            <table className="board">
              <thead>
                <tr>
                  <th>Trader</th>
                  <th>Joined</th>
                  <th className="num">Volume</th>
                  <th className="num">You earned</th>
                </tr>
              </thead>
              <tbody>
                {referrals.map((r) => (
                  <tr key={r.account_id}>
                    <td>
                      <Link to={`/u/${r.account_id}`}>{shortAccount(r.account_id, 26)}</Link>
                    </td>
                    <td className="muted">{timeAgo(r.joined)}</td>
                    <td className="num mono">{usd(r.volume_usd)}</td>
                    <td className="num mono">{usd(r.earned_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="card">
        <header className="card__head">
          <h2>History</h2>
        </header>
        {history.length === 0 ? (
          <p className="empty">{error ? "History unavailable right now." : "No activity yet."}</p>
        ) : (
          <ul className="history">
            {history.map((row) => (
              <li key={`${row.tx_hash}-${row.event}-${row.ts}-${row.order_id}`} className={`history__row history__row--${row.event}`}>
                <span className="history__what">{describe(row, tokens, orderTokenIn)}</span>
                <span className="history__meta">
                  {row.volume_usd !== null && <span className="mono">{usd(row.volume_usd)}</span>}
                  <a href={`${NET.explorer}/txns/${row.tx_hash}`} target="_blank" rel="noreferrer" title={new Date(row.ts).toLocaleString()}>
                    {timeAgo(row.ts)}
                  </a>
                </span>
              </li>
            ))}
          </ul>
        )}
        {more && (
          <button className="btn-ghost load-more" onClick={loadMore}>
            Load more
          </button>
        )}
      </section>
    </main>
  );
}
