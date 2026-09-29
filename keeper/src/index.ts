// readersEXIT keeper: watches open orders and executes them on Ref Finance
// when a limit price is reachable or a DCA slice is due.

import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, FailoverRpcProvider, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { formatUnits, rpc, rpcUrls, view } from "../../shared/near";
import { RefRouter } from "../../shared/ref";
import { NETWORKS, type Config, type NetworkId, type Order } from "../../shared/types";

const network = (process.env.NETWORK ?? "mainnet") as NetworkId;
const net = NETWORKS[network];
const rpcUrl = process.env.RPC_URL ?? net.rpcUrl;
const contractId = required("CONTRACT_ID");
const accountId = process.env.KEEPER_ACCOUNT_ID;
const privateKey = (process.env.KEEPER_PRIVATE_KEY || credentialsKey()) as KeyPairString | undefined;
const pollMs = Number(process.env.POLL_MS ?? 15_000);
const slippageBps = BigInt(process.env.SLIPPAGE_BPS ?? 50);
const dryRun = process.env.DRY_RUN === "1" || !accountId || !privateKey;

const EXECUTE_GAS = 200_000_000_000_000n;
const BPS = 10_000n;

const router = new RefRouter(rpcUrl, net.refId, [...net.hubs]);
const provider = new FailoverRpcProvider(rpcUrls(rpcUrl).map((url) => new JsonRpcProvider({ url })));
const account = dryRun ? null : new Account(accountId!, provider, privateKey!);
const decimalsCache = new Map<string, number>();

/** Fall back to the key near-cli stores in ~/.near-credentials/<network>/<account>.json. */
function credentialsKey(): string | undefined {
  if (!accountId) return undefined;
  const file = process.env.KEEPER_CREDENTIALS_FILE ?? join(homedir(), ".near-credentials", network, `${accountId}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")).private_key;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

async function decimals(token: string): Promise<number> {
  if (!decimalsCache.has(token)) {
    const meta = await view<{ decimals: number }>(rpcUrl, token, "ft_metadata");
    decimalsCache.set(token, meta.decimals);
  }
  return decimalsCache.get(token)!;
}

async function fetchOrders(): Promise<Order[]> {
  const all: Order[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<Order[]>(rpcUrl, contractId, "get_orders", { from_index: from, limit: 100 });
    all.push(...page);
    if (page.length < 100) return all;
  }
}

async function call(methodName: string, args: Record<string, unknown>) {
  if (!account) {
    log(`[dry-run] ${methodName}`, JSON.stringify(args));
    return;
  }
  await account.callFunction({ contractId, methodName, args, gas: EXECUTE_GAS, deposit: 0n });
}

function gross(minNet: bigint, feeBps: bigint): bigint {
  return feeBps === 0n || minNet === 0n ? minNet : (minNet * BPS) / (BPS - feeBps) + 1n;
}

async function processOrder(order: Order, feeBps: bigint, isKeeper: boolean, now: number) {
  const kind = order.kind;
  let amountIn: bigint;
  let userMin: bigint;

  if (kind.type === "limit") {
    if (kind.expires_at_sec !== null && now >= kind.expires_at_sec) {
      log(`order ${order.id}: expired, closing`);
      return call("expire", { order_id: order.id });
    }
    amountIn = BigInt(order.remaining_in);
    userMin = gross(BigInt(kind.min_amount_out), feeBps);
  } else {
    if (!isKeeper || now < kind.next_exec_at_sec) return;
    const per = BigInt(kind.amount_per_swap);
    const remaining = BigInt(order.remaining_in);
    amountIn = per < remaining ? per : remaining;
    userMin = gross((BigInt(kind.min_out_per_swap) * amountIn) / per, feeBps);
  }

  const quote = await router.quote(order.token_in, order.token_out, amountIn);
  if (!quote) return;
  if (quote.amountOut < userMin) {
    if (kind.type === "dca") log(`order ${order.id}: DCA slice skipped, above max price`);
    return;
  }

  const withSlippage = (quote.amountOut * (BPS - slippageBps)) / BPS;
  const minOut = withSlippage > userMin ? withSlippage : userMin;
  const decOut = await decimals(order.token_out);
  log(
    `order ${order.id} (${kind.type}): ${quote.path.join(" -> ")} ` +
      `quote ${formatUnits(quote.amountOut, decOut)} min ${formatUnits(minOut, decOut)}`,
  );
  await call("execute", { order_id: order.id, route: quote.route, min_amount_out: minOut.toString() });
}

async function tick() {
  const config = await view<Config>(rpcUrl, contractId, "get_config");
  if (config.paused) return log("contract paused");
  const keepers = await view<string[]>(rpcUrl, contractId, "get_keepers");
  const isKeeper = !!accountId && (keepers.includes(accountId) || config.owner_id === accountId);
  const orders = (await fetchOrders()).filter((o) => o.status === "Open");
  const now = Math.floor(Date.now() / 1000);
  for (const order of orders) {
    try {
      await processOrder(order, BigInt(config.fee_bps), isKeeper, now);
    } catch (e) {
      log(`order ${order.id}: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------- health

const HEALTH_EVERY_MS = 10 * 60_000;
const MIN_CONTRACT_FREE = 10n ** 24n; // 1 NEAR spare for storage growth
const MIN_KEEPER_FREE = 3n * 10n ** 23n; // 0.3 NEAR for gas
const STORAGE_PRICE = 10n ** 19n; // yoctoNEAR per byte

/** NEAR not locked for storage. */
async function freeNear(account: string): Promise<bigint> {
  const acc = await rpc<{ amount: string; storage_usage: number }>(rpcUrl, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: account,
  });
  return BigInt(acc.amount) - BigInt(acc.storage_usage) * STORAGE_PRICE;
}

let lastHealth = 0;
async function healthCheck() {
  if (Date.now() - lastHealth < HEALTH_EVERY_MS) return;
  lastHealth = Date.now();
  const checks: [string, bigint, string][] = [[contractId, MIN_CONTRACT_FREE, "storage"]];
  if (accountId) checks.push([accountId, MIN_KEEPER_FREE, "gas"]);
  for (const [account, min, purpose] of checks) {
    try {
      const free = await freeNear(account);
      const msg = `${account} has ${formatUnits(free, 24, 3)} NEAR free for ${purpose}`;
      log(free < min ? `WARNING: ${msg} — top it up (below ${formatUnits(min, 24, 1)})` : `health: ${msg}`);
    } catch (e) {
      log(`health check for ${account} failed: ${(e as Error).message}`);
    }
  }
}

async function main() {
  log(`readersEXIT keeper on ${network} for ${contractId}${dryRun ? " (dry run)" : ` as ${accountId}`}`);
  // Hosts only; never print API keys.
  const hosts = rpcUrls(rpcUrl).map((u) => {
    const url = new URL(u);
    return url.host + (url.searchParams.has("apiKey") ? " (keyed)" : "");
  });
  log(`RPC: ${hosts.join(" -> ")}`);
  // Failover would silently hide a rejected key, so probe the primary endpoint once.
  try {
    const res = await fetch(rpcUrls(rpcUrl)[0], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "status", params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    log(`RPC primary ${hosts[0]}: HTTP ${res.status}${res.ok ? " OK" : " — will fail over"}`);
  } catch (e) {
    log(`RPC primary ${hosts[0]}: unreachable (${(e as Error).name}) — will fail over`);
  }
  log("loading Ref pools...");
  await router.load();
  for (;;) {
    try {
      await healthCheck();
      await tick();
    } catch (e) {
      log("tick failed:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main();
