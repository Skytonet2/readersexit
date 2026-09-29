import { useCallback, useEffect, useMemo, useState } from "react";
import type { Config, Order, TokenBalance } from "../../../shared/types";
import {
  ftBalance,
  ftStorage,
  getAccountOrders,
  getAllOrders,
  getBalances,
  getCatalog,
  getConfig,
  getToken,
  getTokenIds,
  getUsdPrices,
  type CatalogEntry,
  type Token,
} from "../api";
import { BalancesPanel } from "../components/BalancesPanel";
import { ExitWall } from "../components/ExitWall";
import { OrdersPanel } from "../components/OrdersPanel";
import { TradePanel } from "../components/TradePanel";
import { CONTRACT_ID, FALLBACK_TOKENS, NET, NETWORK } from "../config";
import { useWallet } from "../wallet";

export function TradePage({ onConfig }: { onConfig: (config: Config | null) => void }) {
  const { accountId } = useWallet();
  const [config, setConfig] = useState<Config | null>(null);
  const [offline, setOffline] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [listed, setListed] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [pair, setPair] = useState<[string, string]>(["", ""]);
  const [usd, setUsd] = useState<Record<string, number>>({});
  const [myOrders, setMyOrders] = useState<Order[]>([]);
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [wrapped, setWrapped] = useState(0n);
  const [allOrders, setAllOrders] = useState<Order[]>([]);
  const [market, setMarket] = useState(0);
  const [tick, setTick] = useState(0);

  const tokenMap = useMemo(() => Object.fromEntries(tokens.map((t) => [t.id, t])), [tokens]);

  useEffect(() => onConfig(config), [config, onConfig]);

  // Contract config + listed tokens.
  useEffect(() => {
    (async () => {
      let ids: string[] = FALLBACK_TOKENS;
      // Only treat the contract as missing when the chain says so; retry transient RPC errors.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const [cfg, listedIds] = await Promise.all([getConfig(), getTokenIds()]);
          setConfig(cfg);
          setListed(new Set(listedIds));
          ids = listedIds;
          break;
        } catch (e) {
          if (/does not exist|CodeDoesNotExist|MethodNotFound/i.test(String(e))) {
            setOffline(true);
            break;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      const loaded = (await Promise.allSettled(ids.map(getToken)))
        .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
        .sort((a, b) => (a.id === NET.wrapNear ? -1 : b.id === NET.wrapNear ? 1 : a.label.localeCompare(b.label)));
      setTokens(loaded);
      const quotes = new Set<string>(NET.hubs);
      const first = loaded.find((t) => t.id === NET.wrapNear) ?? loaded[0];
      const meme = loaded.find((t) => !quotes.has(t.id) && t.id !== first?.id) ?? loaded[1];
      if (first && meme) setPair([first.id, meme.id]);
    })();
    getUsdPrices().then(setUsd);
    getCatalog().then(setCatalog);
  }, []);

  // Periodic refresh.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (offline) return;
    getAllOrders().then(setAllOrders).catch(() => {});
    getConfig().then(setConfig).catch(() => {});
    getTokenIds()
      .then((ids) => setListed(new Set(ids)))
      .catch(() => {});
  }, [tick, offline]);

  // Load metadata for any token picked that isn't loaded yet (unlisted / brand-new launches).
  useEffect(() => {
    const missing = pair.filter((id) => id && !tokenMap[id]);
    if (!missing.length) return;
    Promise.allSettled(missing.map(getToken)).then((res) => {
      const loaded = res.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (loaded.length) setTokens((ts) => [...ts, ...loaded.filter((t) => !ts.some((x) => x.id === t.id))]);
      // Not a fungible token: undo the pick.
      if (loaded.length < missing.length)
        setPair(([a, b]) => [
          tokenMap[a] || loaded.some((t) => t.id === a) ? a : "",
          tokenMap[b] || loaded.some((t) => t.id === b) ? b : "",
        ]);
    });
  }, [pair, tokenMap]);

  useEffect(() => {
    if (!accountId || offline) {
      setMyOrders([]);
      setBalances([]);
      setWrapped(0n);
      return;
    }
    getAccountOrders(accountId).then(setMyOrders).catch(() => {});
    getBalances(accountId).then(setBalances).catch(() => {});
    ftStorage(NET.wrapNear, accountId)
      .then((reg) => (reg ? ftBalance(NET.wrapNear, accountId) : 0n))
      .then(setWrapped)
      .catch(() => {});
  }, [accountId, tick, offline]);

  // Chain state lags a couple of blocks behind the wallet's confirmation.
  const refresh = useCallback(() => {
    setTick((n) => n + 1);
    setTimeout(() => setTick((n) => n + 1), 3000);
  }, []);

  const onPair = useCallback((a: string, b: string) => {
    setPair(([pa, pb]) => {
      if (!a) a = pa;
      if (!b) b = pb;
      if (a === b) return [pb, pa];
      return [a, b];
    });
  }, []);

  const onMarket = useCallback((_: unknown, outPerIn: number) => setMarket(outPerIn), []);

  return (
    <>
      {offline && (
        <div className="banner">
          <strong>{CONTRACT_ID}</strong> isn't live on {NETWORK} yet — quotes work, placing orders is disabled.
        </div>
      )}
      <main className="layout">
        <div className="col">
          <TradePanel
            tokens={tokens}
            catalog={catalog}
            listed={listed}
            config={offline ? null : config}
            tokenIn={tokenMap[pair[0]]}
            tokenOut={tokenMap[pair[1]]}
            onPair={onPair}
            usd={usd}
            onPlaced={refresh}
            onMarket={onMarket}
          />
        </div>
        <aside className="col">
          <ExitWall orders={allOrders} tokenIn={tokenMap[pair[0]]} tokenOut={tokenMap[pair[1]]} marketOutPerIn={market} />
          {accountId && !offline && (
            <BalancesPanel balances={balances} wrapped={wrapped} tokenMap={tokenMap} usd={usd} onChanged={refresh} />
          )}
          {accountId && !offline && <OrdersPanel orders={myOrders} tokenMap={tokenMap} onChanged={refresh} />}
        </aside>
      </main>
    </>
  );
}
