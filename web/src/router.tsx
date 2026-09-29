// Minimal pathname router: the site has four pages, a library would be overkill.
// Vercel rewrites every path to index.html, so deep links work.

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

const EVENT = "rx:navigate";

export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return path;
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle new-tab / modified clicks.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
