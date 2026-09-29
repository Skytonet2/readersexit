import { useCallback, useEffect, useState } from "react";
import type { Config } from "../../shared/types";
import { CONTRACT_ID, NET } from "./config";
import { shortAccount } from "./format";
import { LandingPage } from "./pages/Landing";
import { LeaderboardPage } from "./pages/Leaderboard";
import { ProfilePage } from "./pages/Profile";
import { TradePage } from "./pages/Trade";
import { captureReferral, isAccountId } from "./referral";
import { Link, usePath } from "./router";
import { useWallet } from "./wallet";

const NAV = [
  { to: "/trade", label: "Trade" },
  { to: "/leaderboard", label: "Leaderboard" },
  { to: "/profile", label: "Profile" },
];

function Page({ path, onConfig }: { path: string; onConfig: (c: Config | null) => void }) {
  if (path === "/trade") return <TradePage onConfig={onConfig} />;
  if (path === "/leaderboard") return <LeaderboardPage />;
  if (path === "/profile") return <ProfilePage account={null} />;
  const user = path.match(/^\/u\/([^/]+)\/?$/)?.[1];
  if (user && isAccountId(decodeURIComponent(user).toLowerCase())) {
    return <ProfilePage account={decodeURIComponent(user).toLowerCase()} />;
  }
  return <LandingPage />;
}

export default function App() {
  const { accountId, ready, signIn, signOut } = useWallet();
  const path = usePath();
  const [config, setConfig] = useState<Config | null>(null);
  const onConfig = useCallback((c: Config | null) => setConfig(c), []);

  useEffect(captureReferral, []);

  return (
    <>
      <header className="top">
        <Link to="/" className="logo">
          <span className="logo__readers">readers</span>
          <span className="logo__exit">
            EXIT
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
              <path d="M3 8h9m-3.5-4 4 4-4 4" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={path === n.to ? "nav__link active" : "nav__link"}>
              {n.label}
            </Link>
          ))}
        </nav>
        {path === "/trade" && config && (
          <div className="top__stats small">
            <span>
              <strong>{config.open_orders}</strong> open
            </span>
          </div>
        )}
        {accountId ? (
          <button className="btn-ghost wallet-btn" onClick={signOut} title="Disconnect">
            <span className="dot" /> {shortAccount(accountId, 22)}
          </button>
        ) : (
          <button className="btn" disabled={!ready} onClick={signIn}>
            Connect
          </button>
        )}
      </header>

      <Page path={path} onConfig={onConfig} />

      <footer className="foot small muted">
        <span>readersEXIT · non-custodial escrow on NEAR</span>
        <a href={`${NET.explorer}/address/${CONTRACT_ID}`} target="_blank" rel="noreferrer">
          {CONTRACT_ID}
        </a>
        <a href="https://github.com/Skytonet2/readersexit" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <span>Memecoins are volatile. Trade what you can afford to lose.</span>
      </footer>
    </>
  );
}
