import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";

// CORS is restricted to an explicit allowlist — a bare `cors()` with no
// options reflects any Origin header, which lets any website make
// credentialed-looking requests against this API from a victim's browser.
const allowedOrigins = (process.env.WEB_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Per-request rather than a static options object, so it can also allow a
// request whose Origin genuinely matches the host it was sent to — the
// single-service deployment (this server serves the built frontend itself,
// see app.ts) means "same origin" in practice, but the browser still sends
// an Origin header for module-script/stylesheet/fetch loads regardless
// (Vite marks its built asset tags `crossorigin`, and fetch/XHR always
// sends Origin). Without this, WEB_ORIGIN would have to be kept in exact
// sync with whatever URL the platform assigns the deployment, which is a
// deployment footgun for no actual security benefit — restricting an
// origin from talking to itself doesn't protect against anything.
export const corsOptions = (req: Request, callback: (err: Error | null, options?: { origin: boolean }) => void) => {
  const origin = req.headers.origin;
  if (!origin) {
    // No Origin header (server-to-server, curl, mobile webview) — the
    // browser-enforced same-origin policy is what CORS actually protects
    // against, so this doesn't weaken anything.
    return callback(null, { origin: true });
  }
  if (allowedOrigins.includes(origin)) {
    return callback(null, { origin: true });
  }
  const requestHost = req.headers["x-forwarded-host"] ?? req.headers.host;
  try {
    if (requestHost && new URL(origin).host === requestHost) {
      return callback(null, { origin: true });
    }
  } catch {
    // Malformed Origin header — fall through to reject.
  }
  callback(new Error("Not allowed by CORS"));
};

// Brute-force protection on login: tight enough to slow down password
// guessing, loose enough not to lock out a real user mistyping a password
// a couple of times.
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

// General API rate limit — mainly to blunt scripted scraping of SKU/price
// data, not meant to interfere with normal interactive use.
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Slow down." },
});

// Rejects (or in front of a proxy that sets x-forwarded-proto, redirects)
// any request that didn't arrive over TLS. Only active when REQUIRE_HTTPS
// is set — this app itself doesn't terminate TLS, a reverse proxy or the
// hosting platform does, so this is a defense-in-depth check that proxy is
// actually in place, not a substitute for it.
export function enforceHttps(req: Request, res: Response, next: NextFunction) {
  if (process.env.REQUIRE_HTTPS !== "true") return next();
  const proto = req.headers["x-forwarded-proto"];
  if (req.secure || proto === "https") return next();
  return res.status(403).json({ error: "HTTPS is required" });
}

// Keeps this app out of search engines / crawlers regardless of how it's
// deployed — there's no legitimate reason for any of this to be indexed.
export function noIndex(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  next();
}
