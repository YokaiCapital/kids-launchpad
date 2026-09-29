import {trustedGatewayContext} from './trusted-gateway.mjs';
import {randomBytes} from "node:crypto";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const newCsrfToken = () => randomBytes(24).toString("hex");
export function isLoopbackPeer(request) {
  const address = request?.socket?.remoteAddress;
  return typeof address === "string" && LOOPBACK.has(address);
}

/**
 * Walls 1 and 2, and the Sec-Fetch-Site check: the peer is this machine, the
 * Host is this viewer's own loopback name and port, and any Origin or
 * Sec-Fetch-Site that is present belongs to this page. Returns null when the
 * request may proceed, or the refusal to send. Exported whole so the tests can
 * drive it without a socket.
 *
 * Applied to EVERY route the viewer serves, not only the vault (security review
 * SEC2-02, 10 Sep 2026). The three walls were built here and reached from one
 * branch of the request handler, so `/api/*` — the branch that attaches the
 * operator bearer token — `/`, `/context/*`, `/work.json` and the static tree
 * checked nothing. A page served from `http://attacker.example:8799` whose DNS
 * was rebound to 127.0.0.1 after load was then SAME-ORIGIN with the viewer: it
 * could read the whole operator read API through the proxy, and could read the
 * per-boot vault CSRF token straight out of the index page, which retired wall
 * 3. `subject` only names the surface in the refusal text; the rules are
 * identical, deliberately, so there is one thing to reason about.
 */
export function guardLocalRequest(request, { port, subject = "The admin viewer", allowGateway = false }) {
  if (!isLoopbackPeer(request)) {
    return { status: 403, body: { error: "not-loopback", detail: `${subject} answers this machine only.` } };
  }
  const host = String(request.headers?.host ?? "");
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!allowed.includes(host)) {
    return { status: 403, body: { error: "bad-host", detail: `${subject} answers ${allowed.join(", ")} only; this request said Host: ${host || "(none)"}.` } };
  }
  if (allowGateway && trustedGatewayContext(request,{port})) return null;
  const origin = request.headers?.origin;
  // A same-origin GET sends no Origin at all; a POST always sends one.
  if (origin !== undefined && origin !== `http://${host}`) {
    return { status: 403, body: { error: "bad-origin", detail: `${subject} answers its own page only; this request came from ${origin}.` } };
  }
  const site = request.headers?.["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return { status: 403, body: { error: "bad-site", detail: `This request was made from ${site} context.` } };
  }
  return null;
}

