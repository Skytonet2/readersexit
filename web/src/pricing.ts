import { amountAtPrice, formatUnits, numToDecimal, parsePrice } from "../../shared/near";
import { NET } from "./config";

const QUOTE_TOKENS = new Set<string>(NET.hubs);

/**
 * Which side of the pair is "priced" (1 base = P quote).
 * Memes are priced in NEAR/stables regardless of trade direction.
 */
export type Base = "in" | "out";

export function defaultBase(tokenIn: string, tokenOut: string): Base {
  return QUOTE_TOKENS.has(tokenIn) && !QUOTE_TOKENS.has(tokenOut) ? "out" : "in";
}

export function baseAndQuote(tokenIn: string, tokenOut: string): [string, string] {
  return defaultBase(tokenIn, tokenOut) === "out" ? [tokenOut, tokenIn] : [tokenIn, tokenOut];
}

/** Convert an out-per-in price into the displayed orientation (and back — it's symmetric). */
export function orient(outPerIn: number, base: Base): number {
  if (base === "in") return outPerIn;
  return outPerIn > 0 ? 1 / outPerIn : 0;
}

/** Minimum output for `amountIn` at a displayed price. */
export function minOutAt(amountIn: bigint, priceStr: string, base: Base, decIn: number, decOut: number): bigint {
  const p = parsePrice(priceStr);
  if (p === 0n || amountIn === 0n) return 0n;
  if (base === "in") return amountAtPrice(amountIn, p, decIn, decOut);
  return (amountIn * 10n ** BigInt(decOut) * 10n ** 18n) / (10n ** BigInt(decIn) * p);
}

export function fmtNum(n: number, sig = 6): string {
  if (!isFinite(n) || n === 0) return "0";
  if (n >= 1) return n.toLocaleString("en-US", { maximumSignificantDigits: sig });
  return numToDecimal(n, Math.min(sig, 5));
}

export function fmtPriceInput(n: number): string {
  return numToDecimal(n, 6);
}

export function fmtUsd(n: number): string {
  if (!isFinite(n) || n <= 0) return "";
  if (n < 0.01) return "<$0.01";
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

export function fmtAmount(raw: bigint | string, decimals: number): string {
  return formatUnits(raw, decimals, 4);
}

export function fmtDuration(sec: number): string {
  if (sec <= 0) return "now";
  const units: [number, string][] = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [s, u] of units) if (sec >= s) return `${Math.round(sec / s)}${u}`;
  return `${sec}s`;
}
