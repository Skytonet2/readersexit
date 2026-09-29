// Client for the readersEXIT indexer API (proxied at /api by Vercel and Vite).

const BASE: string = import.meta.env.VITE_API_URL ?? "/api";

export interface Stats {
  traders: number;
  orders: number;
  fills: number;
  volume_usd: number;
  tokens_listed: number;
}

export interface Campaign {
  id: string;
  name: string;
  start: string;
  end: string;
  description?: string;
  prizes?: string[];
  status: "upcoming" | "active" | "ended";
}

export interface LeaderRow {
  rank: number;
  account_id: string;
  volume_usd: number;
  fills: number;
}

export interface Profile {
  account_id: string;
  volume_usd: number;
  fills: number;
  orders: number;
  fees_paid_usd: number;
  first_seen: string | null;
  last_seen: string | null;
  referrer_id: string | null;
  referrals: number;
  referred_traders: number;
  referral_earnings_usd: number;
  campaign_rank: { campaign: string; rank: number; volume_usd: number } | null;
}

export interface HistoryRow {
  event: string;
  ts: string;
  tx_hash: string;
  order_id: number | null;
  data: Record<string, unknown>;
  volume_usd: number | null;
  fee_usd: number | null;
}

export interface ReferralRow {
  account_id: string;
  joined: string;
  volume_usd: number;
  earned_usd: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

export const getStats = () => get<Stats>("/stats");
export const getCampaigns = () => get<Campaign[]>("/campaigns");
export const getLeaderboard = (campaignId?: string) =>
  get<{ campaign: Campaign | null; rows: LeaderRow[] }>(
    `/leaderboard${campaignId ? `?campaign=${encodeURIComponent(campaignId)}` : ""}`,
  );
export const getProfile = (account: string) => get<Profile>(`/profile/${encodeURIComponent(account)}`);
export const getHistory = (account: string, before?: string) =>
  get<HistoryRow[]>(`/history/${encodeURIComponent(account)}?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`);
export const getReferrals = (account: string) => get<ReferralRow[]>(`/referrals/${encodeURIComponent(account)}`);
