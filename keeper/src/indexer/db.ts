import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

/** Idempotent schema setup; runs on every start. */
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      receipt_id   TEXT        NOT NULL,
      log_index    INT         NOT NULL,
      tx_hash      TEXT        NOT NULL,
      block_height BIGINT      NOT NULL,
      ts           TIMESTAMPTZ NOT NULL,
      event        TEXT        NOT NULL,
      account_id   TEXT,
      order_id     BIGINT,
      data         JSONB       NOT NULL,
      -- order_executed only: USD value of the fill, the fee, and the referrer's cut.
      volume_usd   DOUBLE PRECISION,
      fee_usd      DOUBLE PRECISION,
      referral_usd DOUBLE PRECISION,
      PRIMARY KEY (receipt_id, log_index)
    );
    CREATE INDEX IF NOT EXISTS events_account_ts ON events (account_id, ts DESC);
    CREATE INDEX IF NOT EXISTS events_event_ts ON events (event, ts);
    CREATE INDEX IF NOT EXISTS events_order ON events (order_id);
    CREATE INDEX IF NOT EXISTS events_referrer ON events ((data->>'referrer_id')) WHERE event = 'order_executed';

    CREATE TABLE IF NOT EXISTS processed_txs (
      tx_hash      TEXT   PRIMARY KEY,
      block_height BIGINT NOT NULL
    );
  `);
}

/** Resume point: the highest block whose transactions were fully processed. */
export async function cursor(): Promise<number> {
  const { rows } = await pool.query<{ h: string | null }>("SELECT max(block_height) AS h FROM processed_txs");
  return rows[0].h ? Number(rows[0].h) : 0;
}
