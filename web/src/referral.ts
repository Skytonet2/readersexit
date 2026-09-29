// Referral links: ?ref=<account> is remembered (first link wins) and bound on-chain
// with `set_referrer` in the user's next contract transaction.

const KEY = "rx_ref";
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isAccountId(s: string): boolean {
  return s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
}

/** Store ?ref= from the URL (if none stored yet) and tidy the URL. */
export function captureReferral() {
  const params = new URLSearchParams(location.search);
  const ref = params.get("ref")?.trim().toLowerCase();
  if (!ref) return;
  try {
    if (isAccountId(ref) && !localStorage.getItem(KEY)) localStorage.setItem(KEY, ref);
  } catch {
    // Storage blocked (private mode): the referral just isn't remembered.
  }
  params.delete("ref");
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
}

export function storedReferrer(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function referralLink(account: string): string {
  return `${location.origin}/?ref=${encodeURIComponent(account)}`;
}
