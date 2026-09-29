import { useEffect, useState } from "react";
import { countdown, num, shortAccount, usd } from "../format";
import { getCampaigns, getLeaderboard, type Campaign, type LeaderRow } from "../indexer";
import { Link } from "../router";
import { useWallet } from "../wallet";

const ALL_TIME = "__all__";

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function LeaderboardPage() {
  const { accountId } = useWallet();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [error, setError] = useState(false);
  const now = useNow();

  useEffect(() => {
    getCampaigns()
      .then((list) => {
        setCampaigns(list);
        const pick = list.find((c) => c.status === "active") ?? list.find((c) => c.status === "upcoming") ?? list[0];
        setSelected(pick?.id ?? ALL_TIME);
      })
      .catch(() => {
        setCampaigns([]);
        setSelected(ALL_TIME);
      });
  }, []);

  useEffect(() => {
    if (!selected) return;
    setRows(null);
    setError(false);
    const load = () =>
      getLeaderboard(selected === ALL_TIME ? undefined : selected)
        .then((r) => setRows(r.rows))
        .catch(() => setError(true));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [selected]);

  const campaign = campaigns?.find((c) => c.id === selected) ?? null;
  const mine = rows?.find((r) => r.account_id === accountId);

  return (
    <main className="page">
      <header className="page__head">
        <h1>Leaderboard</h1>
        <p className="muted">Ranked by filled volume in USD. Fills against NEAR or stablecoins count at their real value.</p>
      </header>

      <div className="tabs tabs--scroll" role="tablist">
        {campaigns?.map((c) => (
          <button key={c.id} role="tab" aria-selected={selected === c.id} className={selected === c.id ? "active" : ""} onClick={() => setSelected(c.id)}>
            {c.name}
            {c.status === "active" && <span className="live-dot" aria-label="live" />}
          </button>
        ))}
        <button role="tab" aria-selected={selected === ALL_TIME} className={selected === ALL_TIME ? "active" : ""} onClick={() => setSelected(ALL_TIME)}>
          All-time
        </button>
      </div>

      {campaign && (
        <section className="card campaign">
          <div className="campaign__head">
            <span className={`pill pill--${campaign.status}`}>
              {campaign.status === "active" ? "Live" : campaign.status === "upcoming" ? "Upcoming" : "Ended"}
            </span>
            <h2>{campaign.name}</h2>
            <span className="campaign__clock mono">
              {campaign.status === "active" && `ends in ${countdown(Date.parse(campaign.end) - now)}`}
              {campaign.status === "upcoming" && `starts in ${countdown(Date.parse(campaign.start) - now)}`}
              {campaign.status === "ended" && `ended ${new Date(campaign.end).toLocaleDateString()}`}
            </span>
          </div>
          {campaign.description && <p className="muted">{campaign.description}</p>}
          {!!campaign.prizes?.length && (
            <ol className="prizes">
              {campaign.prizes.map((p, i) => (
                <li key={i}>
                  <span className="prizes__place">{["🥇", "🥈", "🥉"][i] ?? `#${i + 1}`}</span> {p}
                </li>
              ))}
            </ol>
          )}
          <p className="fine">
            {new Date(campaign.start).toUTCString()} → {new Date(campaign.end).toUTCString()}
          </p>
        </section>
      )}
      {campaigns && campaigns.length === 0 && (
        <p className="note">No competition running right now — here's the all-time board. Campaigns are announced here first.</p>
      )}

      {accountId && rows && (
        <p className="you-rank">
          {mine ? (
            <>
              You're <strong>#{mine.rank}</strong> with <strong>{usd(mine.volume_usd)}</strong> volume.
            </>
          ) : (
            <>
              You're not on this board yet. <Link to="/trade">Place a trade →</Link>
            </>
          )}
        </p>
      )}

      <section className="card">
        {error ? (
          <p className="empty">Leaderboard is temporarily unavailable.</p>
        ) : !rows ? (
          <p className="empty">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="empty">No fills yet{campaign?.status === "upcoming" ? " — it hasn't started." : ". Be first."}</p>
        ) : (
          <table className="board">
            <thead>
              <tr>
                <th>#</th>
                <th>Trader</th>
                <th className="num">Volume</th>
                <th className="num">Fills</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.account_id} className={r.account_id === accountId ? "is-me" : ""}>
                  <td className="board__rank">{r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : r.rank}</td>
                  <td>
                    <Link to={`/u/${r.account_id}`}>{shortAccount(r.account_id, 28)}</Link>
                  </td>
                  <td className="num mono">{usd(r.volume_usd)}</td>
                  <td className="num mono">{num(r.fills)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
