import { useEffect, useState } from "react";
import { CONTRACT_ID, NET } from "../config";
import { num, usd } from "../format";
import { getCampaigns, getStats, type Campaign, type Stats } from "../indexer";
import { Link } from "../router";

const REPO = "https://github.com/Skytonet2/readersexit";

const FEATURES: { title: string; body: string; icon: string }[] = [
  {
    title: "Limit orders",
    body: "Set the price you want out (or in). The contract refuses any fill below it — no keeper can dump you cheaper.",
    icon: "M4 17l5-5 4 4 7-8M15 8h5v5",
  },
  {
    title: "DCA",
    body: "Split a buy or sell across hours or days. Add a max price and thin pools can't eat your slices.",
    icon: "M4 19h16M6 16v-3m4 3V9m4 7v-5m4 5V6",
  },
  {
    title: "Exit wall",
    body: "See every resting sell and dip-buy on a pair before you place yours. Know where the exits are stacked.",
    icon: "M5 5h14M5 9h10M5 13h12M5 17h7",
  },
  {
    title: "Any NEAR token",
    body: "Search every token on Ref or paste a contract ID. Fresh launches can be listed in one click.",
    icon: "M12 4v16M4 12h16",
  },
  {
    title: "Trap-pool guard",
    body: "Pools charging over 1% are ignored and price impact is shown up front. DCA slices skip thin pools.",
    icon: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z",
  },
  {
    title: "Earn by referring",
    body: "Share your link: you get half of the 1% fee on every fill your referrals make, forever — paid on-chain.",
    icon: "M8 12h8M12 8v8M4 12a8 8 0 1016 0 8 8 0 10-16 0",
  },
];

function Icon({ d }: { d: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d={d} stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LandingPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [campaign, setCampaign] = useState<Campaign | null>(null);

  useEffect(() => {
    getStats().then(setStats).catch(() => {});
    getCampaigns()
      .then((list) => setCampaign(list.find((c) => c.status === "active") ?? list.find((c) => c.status === "upcoming") ?? null))
      .catch(() => {});
  }, []);

  return (
    <div className="landing">
      <section className="landing__hero">
        <div className="landing__copy">
          <span className="eyebrow">Limit orders & DCA for NEAR memecoins</span>
          <h1>
            Set your exit.
            <br />
            <em>Stack the dip.</em>
          </h1>
          <p className="lead">
            Park your sell at the top or your buy at the dip, and walk away. readersEXIT escrows your tokens on-chain and
            fills through Ref Finance the moment your price hits — with your price enforced by the contract.
          </p>
          <div className="landing__cta">
            <Link to="/trade" className="cta cta--inline">
              Launch app
            </Link>
            <Link to="/leaderboard" className="btn-ghost btn-lg">
              Leaderboard
            </Link>
          </div>
        </div>
        <div className="landing__visual" aria-hidden>
          <div className="mock">
            <div className="mock__row mock__ask" style={{ width: "46%" }} />
            <div className="mock__row mock__ask" style={{ width: "72%" }} />
            <div className="mock__row mock__ask" style={{ width: "58%" }} />
            <div className="mock__row mock__ask mock__mine" style={{ width: "88%" }}>
              <span>your exit</span>
            </div>
            <div className="mock__mid">market</div>
            <div className="mock__row mock__bid" style={{ width: "80%" }} />
            <div className="mock__row mock__bid" style={{ width: "52%" }} />
            <div className="mock__row mock__bid" style={{ width: "96%" }} />
            <div className="mock__row mock__bid" style={{ width: "40%" }} />
          </div>
        </div>
      </section>

      <section className="statbar">
        <div>
          <strong>{stats ? usd(stats.volume_usd, true) : "—"}</strong>
          <span>volume filled</span>
        </div>
        <div>
          <strong>{num(stats?.fills)}</strong>
          <span>fills</span>
        </div>
        <div>
          <strong>{num(stats?.traders)}</strong>
          <span>traders</span>
        </div>
        <div>
          <strong>{num(stats?.orders)}</strong>
          <span>orders placed</span>
        </div>
      </section>

      {campaign && (
        <Link to="/leaderboard" className="campaign-banner">
          <span className={`pill pill--${campaign.status}`}>{campaign.status === "active" ? "Live" : "Soon"}</span>
          <strong>{campaign.name}</strong>
          <span className="muted">{campaign.prizes?.length ? campaign.prizes.join(" · ") : "Trading competition"}</span>
          <span className="campaign-banner__go">View leaderboard →</span>
        </Link>
      )}

      <section className="features">
        {FEATURES.map((f) => (
          <article key={f.title} className="feature">
            <span className="feature__icon">
              <Icon d={f.icon} />
            </span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </article>
        ))}
      </section>

      <section className="steps">
        <h2>How it works</h2>
        <ol>
          <li>
            <strong>Pick a pair and a price.</strong> Limit order at your exit price, or DCA across time.
          </li>
          <li>
            <strong>Your tokens go into escrow.</strong> The readersEXIT contract holds them — cancel anytime.
          </li>
          <li>
            <strong>The keeper fills it on Ref.</strong> Only at your price or better. Claim the proceeds from your balance.
          </li>
        </ol>
      </section>

      <section className="trust">
        <div>
          <h3>Verifiable</h3>
          <p>
            Open source with a reproducible build — anyone can rebuild the exact deployed contract.{" "}
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub →
            </a>
          </p>
        </div>
        <div>
          <h3>Reviewed</h3>
          <p>
            Internal security review with every finding tracked. Not yet professionally audited.{" "}
            <a href={`${REPO}/blob/main/AUDIT.md`} target="_blank" rel="noreferrer">
              Read it →
            </a>
          </p>
        </div>
        <div>
          <h3>On-chain</h3>
          <p>
            Fees, referrals and fills all happen in the contract.{" "}
            <a href={`${NET.explorer}/address/${CONTRACT_ID}`} target="_blank" rel="noreferrer">
              {CONTRACT_ID} →
            </a>
          </p>
        </div>
      </section>

      <section className="closing">
        <h2>Your exit, set in stone.</h2>
        <Link to="/trade" className="cta cta--inline">
          Launch app
        </Link>
      </section>
    </div>
  );
}
