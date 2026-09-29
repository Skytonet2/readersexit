// Minimal JSON-RPC helpers shared by the web app and the keeper.

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

class RetryableError extends Error {}

// `rpcList` may be a comma-separated list of endpoints; we stick with whichever
// answered last and rotate to the next one on rate limits / outages.
const preferred = new Map<string, number>();

export function rpcUrls(rpcList: string): string[] {
  return rpcList.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Endpoint currently in use for an RPC list. */
export function currentRpc(rpcList: string): string {
  const urls = rpcUrls(rpcList);
  return urls[(preferred.get(rpcList) ?? 0) % urls.length];
}

/** JSON-RPC call with endpoint failover and backoff. Returns `result`. */
export async function rpc<T>(rpcList: string, method: string, params: unknown): Promise<T> {
  const urls = rpcUrls(rpcList);
  const attempts = Math.max(4, urls.length * 2);
  for (let i = 1; ; i++) {
    try {
      return await rpcOnce<T>(currentRpc(rpcList), method, params);
    } catch (e) {
      // TypeError = network failure; TimeoutError = request hung past the timeout below.
      const retryable =
        e instanceof RetryableError || e instanceof TypeError || (e as Error)?.name === "TimeoutError";
      if (!retryable || i >= attempts) throw e;
      preferred.set(rpcList, (preferred.get(rpcList) ?? 0) + 1);
      // Back off only once every endpoint has been tried.
      const round = Math.floor(i / urls.length);
      await new Promise((r) => setTimeout(r, round ? 400 * 2 ** round + Math.random() * 300 : 50));
    }
  }
}

async function rpcOnce<T>(url: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: "readersexit", method, params }),
  });
  // 401/403 too: an expired or rejected API key should fall back to the next endpoint.
  const host = new URL(url).host; // never include the query string (API key) in errors
  if ([401, 403, 429].includes(res.status) || res.status >= 500) {
    throw new RetryableError(`RPC ${res.status} (${host})`);
  }
  if (!res.ok) throw new Error(`RPC ${res.status} (${host})`);
  const json = await res.json();
  if (json.error) {
    const cause = json.error.cause?.name;
    const message = json.error.data ?? cause ?? json.error.message;
    if (cause === "TIMEOUT_ERROR" || cause === "INTERNAL_ERROR") throw new RetryableError(message);
    throw new Error(message);
  }
  return json.result as T;
}

/** Contract view call. */
export async function view<T>(
  rpcList: string,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await rpc<{ result?: number[]; error?: string }>(rpcList, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: methodName,
    args_base64: toBase64(JSON.stringify(args)),
  });
  if (result.error) throw new Error(result.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result!))) as T;
}

export interface FtMetadata {
  spec: string;
  name: string;
  symbol: string;
  icon: string | null;
  decimals: number;
}

// ---------------------------------------------------------------- amounts

/** "1.5" with 24 decimals -> 1500000000000000000000000n */
export function parseUnits(value: string, decimals: number): bigint {
  const v = value.trim();
  if (!/^\d*\.?\d*$/.test(v) || v === "" || v === ".") return 0n;
  const [whole, frac = ""] = v.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

/** Raw amount -> human string with at most `maxFrac` significant fraction digits. */
export function formatUnits(raw: bigint | string, decimals: number, maxFrac = 6): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0");
  if (whole === 0n && v > 0n) {
    // tiny values: keep `maxFrac` significant digits after leading zeros
    const firstNonZero = frac.search(/[1-9]/);
    const cut = frac.slice(0, firstNonZero + maxFrac).replace(/0+$/, "");
    return `0.${cut}`;
  }
  const cut = frac.slice(0, maxFrac).replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cut ? `${wholeStr}.${cut}` : wholeStr;
}

const PRICE_SCALE = 10n ** 18n;

/** Decimal price string -> bigint scaled by 1e18. */
export function parsePrice(price: string): bigint {
  return parseUnits(price, 18);
}

/**
 * Output amount for `amountIn` at `price` (token_out per token_in, human units).
 */
export function amountAtPrice(amountIn: bigint, price: bigint, decIn: number, decOut: number): bigint {
  return (amountIn * price * 10n ** BigInt(decOut)) / (10n ** BigInt(decIn) * PRICE_SCALE);
}

/** Human price (token_out per token_in) for a raw in/out pair, as a number. */
export function priceOf(amountIn: bigint, amountOut: bigint, decIn: number, decOut: number): number {
  if (amountIn === 0n) return 0;
  const scaled = (amountOut * 10n ** BigInt(decIn) * PRICE_SCALE) / (amountIn * 10n ** BigInt(decOut));
  return Number(scaled) / 1e18;
}

/** Number -> plain decimal string without exponent notation. */
export function numToDecimal(n: number, sig = 8): string {
  if (!isFinite(n) || n <= 0) return "0";
  if (n >= 1e15) return BigInt(Math.round(n)).toString();
  if (n >= 1) return Number(n.toPrecision(sig)).toString();
  const digits = Math.max(0, -Math.floor(Math.log10(n))) + sig - 1;
  return n.toFixed(Math.min(digits, 30)).replace(/0+$/, "").replace(/\.$/, "");
}
