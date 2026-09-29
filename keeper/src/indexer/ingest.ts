// Pulls every transaction touching the contract from FastNEAR and stores the
// contract's EVENT_JSON logs (only from receipts it executed successfully).

import { rpc } from "../../../shared/near";
import { NETWORKS, type NetworkId } from "../../../shared/types";
import { cursor, pool } from "./db";
import { usdValue } from "./prices";

/** Tokens whose price can't be pushed around by one thin pool: NEAR and stablecoins. */
const TRUSTED = new Set<string>(NETWORKS[(process.env.NETWORK ?? "mainnet") as NetworkId].hubs);

const TX_API = process.env.FASTNEAR_TX_URL ?? "https://tx.main.fastnear.com";
const PAGE = 200;
const FETCH_BATCH = 20;
/** Settlement callbacks land a few blocks after the tx; only index settled txs. */
const FINALITY_LAG_BLOCKS = 30;

interface AccountTx {
  transaction_hash: string;
  tx_block_height: number;
}

interface Receipt {
  execution_outcome: {
    block_timestamp: string;
    block_height: number;
    id: string;
    outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> };
  };
}

interface Tx {
  transaction: { hash: string };
  receipts: Receipt[];
}

type EventData = Record<string, unknown>;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${TX_API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`FastNEAR ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function finalHeight(rpcUrl: string): Promise<number> {
  const block = await rpc<{ header: { height: number } }>(rpcUrl, "block", { finality: "final" });
  return block.header.height;
}

/**
 * Leaderboard-grade USD volume for a fill. Meme prices from the feed can be
 * manipulated (thin or trap pools), so:
 *  - against NEAR/USDt/USDC: value the NEAR/stable side actually moved;
 *  - meme <-> meme: the lower of the two sides;
 *  - anything we can't price on both sides: null (doesn't count).
 */
async function fillVolumeUsd(
  rpcUrl: string,
  tokenIn: string,
  amountIn: string,
  tokenOut: string,
  grossOut: bigint,
): Promise<number | null> {
  if (TRUSTED.has(tokenIn)) return usdValue(rpcUrl, tokenIn, amountIn);
  if (TRUSTED.has(tokenOut)) return usdValue(rpcUrl, tokenOut, grossOut);
  const [a, b] = await Promise.all([usdValue(rpcUrl, tokenIn, amountIn), usdValue(rpcUrl, tokenOut, grossOut)]);
  return a !== null && b !== null ? Math.min(a, b) : null;
}

async function storeEvent(rpcUrl: string, tx: Tx, r: Receipt, logIndex: number, event: string, data: EventData) {
  const orderId = (data.order_id ?? (event === "order_created" ? data.id : null)) as number | null;
  const accountId = (data.owner_id ?? data.account_id ?? data.lister_id ?? null) as string | null;

  let volumeUsd: number | null = null;
  let feeUsd: number | null = null;
  let referralUsd: number | null = null;
  if (event === "order_executed") {
    const tokenIn = data.token_in as string;
    const out = data.token_out as string;
    const grossOut = BigInt(data.amount_out as string) + BigInt(data.fee as string);
    volumeUsd = await fillVolumeUsd(rpcUrl, tokenIn, data.amount_in as string, out, grossOut);
    // Fees are paid in token_out; value them at the fill's own rate so a mispriced
    // meme can't inflate them either.
    const outValue = await usdValue(rpcUrl, out, grossOut);
    const rate = volumeUsd !== null && outValue ? volumeUsd / outValue : 1;
    const feeRaw = await usdValue(rpcUrl, out, data.fee as string);
    feeUsd = feeRaw === null ? null : feeRaw * Math.min(rate, 1);
    const refRaw = data.referral_fee ? await usdValue(rpcUrl, out, data.referral_fee as string) : null;
    referralUsd = refRaw === null ? null : refRaw * Math.min(rate, 1);
  }

  await pool.query(
    `INSERT INTO events (receipt_id, log_index, tx_hash, block_height, ts, event, account_id, order_id, data,
                         volume_usd, fee_usd, referral_usd)
     VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1e9), $6,
             -- Cancel/expire/complete events only carry order_id: take the owner from order_created.
             COALESCE($7, (SELECT account_id FROM events WHERE event = 'order_created' AND order_id = $8 LIMIT 1)),
             $8, $9, $10, $11, $12)
     ON CONFLICT DO NOTHING`,
    [
      r.execution_outcome.id,
      logIndex,
      tx.transaction.hash,
      r.execution_outcome.block_height,
      r.execution_outcome.block_timestamp,
      event,
      accountId,
      orderId,
      JSON.stringify(data),
      volumeUsd,
      feeUsd,
      referralUsd,
    ],
  );
}

async function processTx(rpcUrl: string, contractId: string, tx: Tx, height: number): Promise<number> {
  let stored = 0;
  const receipts = [...tx.receipts].sort(
    (a, b) => a.execution_outcome.block_height - b.execution_outcome.block_height,
  );
  for (const r of receipts) {
    const { executor_id, logs, status } = r.execution_outcome.outcome;
    if (executor_id !== contractId || "Failure" in status) continue;
    for (const [i, log] of logs.entries()) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const ev = JSON.parse(log.slice("EVENT_JSON:".length)) as { standard: string; event: string; data: EventData[] };
        if (ev.standard !== "readersexit") continue;
        for (const data of ev.data) {
          await storeEvent(rpcUrl, tx, r, i, ev.event, data);
          stored++;
        }
      } catch (e) {
        console.error(`bad event in ${tx.transaction.hash}: ${(e as Error).message}`);
      }
    }
  }
  await pool.query("INSERT INTO processed_txs (tx_hash, block_height) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    tx.transaction.hash,
    height,
  ]);
  return stored;
}

/** One pass: index every settled tx after the cursor. Returns true if more pages remain. */
export async function ingestOnce(rpcUrl: string, contractId: string): Promise<boolean> {
  const from = await cursor();
  const settled = (await finalHeight(rpcUrl)) - FINALITY_LAG_BLOCKS;
  const { account_txs } = await post<{ account_txs: AccountTx[] }>("/v0/account", {
    account_id: contractId,
    desc: false,
    limit: PAGE,
    from_tx_block_height: from,
  });

  const candidates = account_txs.filter((t) => t.tx_block_height <= settled);
  const { rows } = await pool.query<{ tx_hash: string }>(
    "SELECT tx_hash FROM processed_txs WHERE tx_hash = ANY($1)",
    [candidates.map((t) => t.transaction_hash)],
  );
  const done = new Set(rows.map((r) => r.tx_hash));
  const todo = candidates.filter((t) => !done.has(t.transaction_hash));

  let stored = 0;
  for (let i = 0; i < todo.length; i += FETCH_BATCH) {
    const batch = todo.slice(i, i + FETCH_BATCH);
    const { transactions } = await post<{ transactions: Tx[] }>("/v0/transactions", {
      tx_hashes: batch.map((t) => t.transaction_hash),
    });
    const heights = new Map(batch.map((t) => [t.transaction_hash, t.tx_block_height]));
    // Process in chain order so order_created precedes later events for the same order.
    transactions.sort((a, b) => heights.get(a.transaction.hash)! - heights.get(b.transaction.hash)!);
    for (const tx of transactions) stored += await processTx(rpcUrl, contractId, tx, heights.get(tx.transaction.hash)!);
  }
  if (todo.length) console.log(`${new Date().toISOString()} indexed ${todo.length} txs, ${stored} events (from block ${from})`);
  return account_txs.length === PAGE && candidates.length === account_txs.length;
}
