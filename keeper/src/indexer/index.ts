// readersEXIT indexer: ingests contract events into Postgres and serves the site's API.

import "dotenv/config";
import { NETWORKS, type NetworkId } from "../../../shared/types";
import { startApi } from "./api";
import { migrate } from "./db";
import { ingestOnce } from "./ingest";

const network = (process.env.NETWORK ?? "mainnet") as NetworkId;
const rpcUrl = process.env.RPC_URL ?? NETWORKS[network].rpcUrl;
const contractId = process.env.CONTRACT_ID ?? "readersexit.near";
const pollMs = Number(process.env.INDEX_POLL_MS ?? 5_000);

if (!process.env.DATABASE_URL) {
  console.error("Missing env DATABASE_URL");
  process.exit(1);
}

await migrate();
startApi(Number(process.env.PORT ?? 8080));
console.log(`${new Date().toISOString()} indexing ${contractId} on ${network}`);

for (;;) {
  let more = false;
  try {
    more = await ingestOnce(rpcUrl, contractId);
  } catch (e) {
    console.error(`${new Date().toISOString()} ingest failed: ${(e as Error).message}`);
  }
  if (!more) await new Promise((r) => setTimeout(r, pollMs));
}
