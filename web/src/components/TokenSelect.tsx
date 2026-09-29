import { useEffect, useRef, useState } from "react";
import type { CatalogEntry, Token } from "../api";

export function TokenIcon({ token, size = 22 }: { token?: Token; size?: number }) {
  if (token?.icon) return <img className="token-icon" src={token.icon} width={size} height={size} alt="" />;
  return (
    <span className="token-icon token-icon--fallback" style={{ width: size, height: size }}>
      {token?.label?.[0] ?? "?"}
    </span>
  );
}

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const MAX_UNLISTED_RESULTS = 40;

/**
 * Listed tokens first, then anything Ref knows about, then any pasted contract ID —
 * so brand-new launches can be traded (they get listed on first use).
 */
export function TokenSelect({
  tokens,
  catalog,
  listed,
  value,
  exclude,
  onChange,
}: {
  tokens: Token[];
  catalog: CatalogEntry[];
  listed: Set<string>;
  value?: Token;
  exclude?: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const query = q.trim().toLowerCase();
  const matches = (id: string, symbol: string) =>
    id !== exclude && (symbol.toLowerCase().includes(query) || id.includes(query));

  const known = tokens.filter((t) => matches(t.id, t.label));
  const knownIds = new Set(tokens.map((t) => t.id));
  const listedFirst = [...known].sort((a, b) => Number(listed.has(b.id)) - Number(listed.has(a.id)));
  const more = query
    ? catalog.filter((c) => !knownIds.has(c.id) && matches(c.id, c.symbol)).slice(0, MAX_UNLISTED_RESULTS)
    : [];
  const custom =
    query && ACCOUNT_ID.test(query) && query.includes(".") && !knownIds.has(query) && !more.some((c) => c.id === query)
      ? query
      : null;

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="token-select" ref={ref}>
      <button type="button" className="token-select__btn" onClick={() => setOpen((o) => !o)}>
        <TokenIcon token={value} />
        <span>{value?.label ?? "Select"}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
        </svg>
      </button>
      {open && (
        <div className="token-select__menu">
          <input autoFocus placeholder="Search any NEAR token or paste its contract" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul>
            {listedFirst.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => pick(t.id)}>
                  <TokenIcon token={t} />
                  <span className="token-select__sym">
                    {t.label}
                    {!listed.has(t.id) && <span className="tag">new</span>}
                  </span>
                  <span className="token-select__id">{t.id}</span>
                </button>
              </li>
            ))}
            {more.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => pick(c.id)}>
                  <span className="token-icon token-icon--fallback" style={{ width: 22, height: 22 }}>
                    {c.symbol[0] ?? "?"}
                  </span>
                  <span className="token-select__sym">
                    {c.symbol}
                    <span className="tag">new</span>
                  </span>
                  <span className="token-select__id">{c.id}</span>
                </button>
              </li>
            ))}
            {custom && (
              <li>
                <button type="button" onClick={() => pick(custom)}>
                  <span className="token-icon token-icon--fallback" style={{ width: 22, height: 22 }}>
                    +
                  </span>
                  <span className="token-select__sym">Use token</span>
                  <span className="token-select__id">{custom}</span>
                </button>
              </li>
            )}
            {!query && <li className="muted pad small">Type to search every token on NEAR — new launches too.</li>}
            {query && known.length + more.length === 0 && !custom && <li className="muted pad">No match</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
