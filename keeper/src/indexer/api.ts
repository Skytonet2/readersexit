// Read-only JSON API for the site: stats, history, profile, referrals, campaigns.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pool } from "./db";

export interface Campaign {
  id: string;
  name: string;
  start: string;
  end: string;
  description?: string;
  prizes?: string[];
}

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Campaigns come from the CAMPAIGNS env var (JSON array) so they can be edited in Railway. */
export function campaigns(): (Campaign & { status: "upcoming" | "active" | "ended" })[] {
  let list: Campaign[] = [];
  try {
    list = JSON.parse(process.env.CAMPAIGNS ?? "[]");
  } catch {
    console.error("CAMPAIGNS is not valid JSON; ignoring");
  }
  const now = Date.now();
  return list
    .map((c) => ({
      ...c,
      status: (now < Date.parse(c.start) ? "upcoming" : now >= Date.parse(c.end) ? "ended" : "active") as
        | "upcoming"
        | "active"
        | "ended",
    }))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
}

async function leaderboard(campaignId: string | null, limit = 100) {
  const c = campaignId ? campaigns().find((x) => x.id === campaignId) : null;
  if (campaignId && !c) return null;
  const { rows } = await pool.query(
    `SELECT account_id, sum(volume_usd) AS volume_usd, count(*)::int AS fills
       FROM events
      WHERE event = 'order_executed' AND volume_usd IS NOT NULL
        AND ($1::timestamptz IS NULL OR ts >= $1) AND ($2::timestamptz IS NULL OR ts < $2)
      GROUP BY account_id
      ORDER BY volume_usd DESC
      LIMIT $3`,
    [c?.start ?? null, c?.end ?? null, limit],
  );
  return { campaign: c ?? null, rows: rows.map((r, i) => ({ rank: i + 1, ...r })) };
}

async function stats() {
  const { rows } = await pool.query(`
    SELECT count(DISTINCT account_id) FILTER (WHERE event = 'order_created')::int AS traders,
           count(*) FILTER (WHERE event = 'order_created')::int                  AS orders,
           count(*) FILTER (WHERE event = 'order_executed')::int                 AS fills,
           coalesce(sum(volume_usd), 0)                                          AS volume_usd,
           count(*) FILTER (WHERE event = 'token_listed')::int                   AS tokens_listed
      FROM events`);
  return rows[0];
}

async function history(account: string, limit: number, before: string | null) {
  const { rows } = await pool.query(
    `SELECT event, ts, tx_hash, order_id, data, volume_usd, fee_usd
       FROM events
      WHERE account_id = $1 AND ($2::timestamptz IS NULL OR ts < $2)
      ORDER BY ts DESC, log_index DESC
      LIMIT $3`,
    [account, before, limit],
  );
  return rows;
}

async function profile(account: string) {
  const [{ rows: [totals] }, { rows: [ref] }, { rows: [earned] }] = await Promise.all([
    pool.query(
      `SELECT coalesce(sum(volume_usd), 0) AS volume_usd,
              count(*) FILTER (WHERE event = 'order_executed')::int AS fills,
              count(*) FILTER (WHERE event = 'order_created')::int  AS orders,
              coalesce(sum(fee_usd), 0) AS fees_paid_usd,
              min(ts) AS first_seen, max(ts) AS last_seen
         FROM events WHERE account_id = $1`,
      [account],
    ),
    pool.query(
      `SELECT data->>'referrer_id' AS referrer_id FROM events
        WHERE event = 'referral_set' AND account_id = $1 ORDER BY ts LIMIT 1`,
      [account],
    ),
    pool.query(
      `SELECT count(DISTINCT account_id)::int AS referred_traders, coalesce(sum(referral_usd), 0) AS referral_earnings_usd
         FROM events WHERE event = 'order_executed' AND data->>'referrer_id' = $1`,
      [account],
    ),
  ]);
  const { rows: [invited] } = await pool.query(
    `SELECT count(*)::int AS referrals FROM events WHERE event = 'referral_set' AND data->>'referrer_id' = $1`,
    [account],
  );
  const active = campaigns().find((c) => c.status === "active");
  let campaignRank: { campaign: string; rank: number; volume_usd: number } | null = null;
  if (active) {
    const board = await leaderboard(active.id, 1000);
    const me = board?.rows.find((r) => r.account_id === account);
    if (me) campaignRank = { campaign: active.id, rank: me.rank, volume_usd: me.volume_usd };
  }
  return { account_id: account, ...totals, referrer_id: ref?.referrer_id ?? null, ...invited, ...earned, campaign_rank: campaignRank };
}

async function referrals(account: string) {
  const { rows } = await pool.query(
    `SELECT r.account_id, r.ts AS joined,
            coalesce(sum(e.volume_usd), 0) AS volume_usd,
            coalesce(sum(e.referral_usd), 0) AS earned_usd
       FROM events r
       LEFT JOIN events e ON e.event = 'order_executed' AND e.account_id = r.account_id
                          AND e.data->>'referrer_id' = $1
      WHERE r.event = 'referral_set' AND r.data->>'referrer_id' = $1
      GROUP BY r.account_id, r.ts
      ORDER BY volume_usd DESC`,
    [account],
  );
  return rows;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": status === 200 ? "public, max-age=15" : "no-store",
  });
  res.end(JSON.stringify(body));
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  // Accept both /x and /api/x (the site proxies /api/* here).
  const parts = url.pathname.replace(/^\/api/, "").split("/").filter(Boolean);
  const account = parts[1]?.toLowerCase();
  if (req.method !== "GET") return send(res, 405, { error: "GET only" });
  if (parts[1] !== undefined && !ACCOUNT_RE.test(account ?? "")) return send(res, 400, { error: "bad account id" });

  switch (parts[0]) {
    case undefined:
    case "health":
      return send(res, 200, { ok: true });
    case "stats":
      return send(res, 200, await stats());
    case "campaigns":
      return send(res, 200, campaigns());
    case "leaderboard": {
      const board = await leaderboard(url.searchParams.get("campaign"));
      return board ? send(res, 200, board) : send(res, 404, { error: "unknown campaign" });
    }
    case "history": {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
      return send(res, 200, await history(account!, limit, url.searchParams.get("before")));
    }
    case "profile":
      return send(res, 200, await profile(account!));
    case "referrals":
      return send(res, 200, await referrals(account!));
    default:
      return send(res, 404, { error: "not found" });
  }
}

export function startApi(port: number) {
  createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error("api error:", (e as Error).message);
      send(res, 500, { error: "internal error" });
    });
  }).listen(port, () => console.log(`${new Date().toISOString()} API listening on :${port}`));
}
