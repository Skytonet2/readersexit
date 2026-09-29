import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import type { Tx } from "./api";
import { NETWORK } from "./config";

interface WalletCtx {
  accountId: string | null;
  ready: boolean;
  signIn: () => void;
  signOut: () => Promise<void>;
  send: (txs: Tx[]) => Promise<void>;
}

const Ctx = createContext<WalletCtx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      const s = await setupWalletSelector({
        network: NETWORK,
        modules: [setupMeteorWallet(), setupIntearWallet(), setupHereWallet(), setupMyNearWallet()],
      });
      const active = () => s.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
      setAccountId(active());
      const sub = s.store.observable.subscribe(() => setAccountId(active()));
      unsub = () => sub.unsubscribe();
      setSelector(s);
      setModal(setupModal(s, {}));
    })();
    return () => unsub?.();
  }, []);

  const signIn = useCallback(() => modal?.show(), [modal]);

  const signOut = useCallback(async () => {
    if (!selector) return;
    await (await selector.wallet()).signOut();
    setAccountId(null);
  }, [selector]);

  const send = useCallback(
    async (txs: Tx[]) => {
      if (!selector || !accountId) throw new Error("Connect a wallet first");
      const wallet = await selector.wallet();
      await wallet.signAndSendTransactions({
        transactions: txs.map((t) => ({ signerId: accountId, ...t })),
      });
    },
    [selector, accountId],
  );

  return (
    <Ctx.Provider value={{ accountId, ready: !!selector, signIn, signOut, send }}>{children}</Ctx.Provider>
  );
}

export function useWallet(): WalletCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet outside WalletProvider");
  return ctx;
}
