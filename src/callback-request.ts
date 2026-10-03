// The "call me back" form: validation, bot and flood guards, and the hand-off to n8n.
//
// The visitor leaves a phone number. The route (examples/callback-request-route.ts)
// posts it to an n8n webhook, and the n8n workflow starts a Voximplant scenario in
// which the AI agent calls that number. Every request here can cost a real phone
// call, so the route checks it before anything leaves the server.
import { z } from "zod";

/**
 * Body of POST /api/callback-request.
 *
 * `website` is a honeypot: the field is hidden from people, so only a bot fills it.
 * The phone is checked for length only: the form masks and checks the number on
 * the client, and the server only has to keep junk and huge strings out.
 */
export const callbackRequestSchema = z.object({
  phone: z.string().min(7).max(20),
  source: z.string().max(50).optional(),
  website: z.string().max(200).optional(),
});

export type CallbackRequest = z.infer<typeof callbackRequestSchema>;

/** Which agent calls back when the form does not say. */
export const DEFAULT_SOURCE = "outbound";

/** A bot filled the hidden field. The route answers "ok" and does not call. */
export function isHoneypotFilled(body: CallbackRequest): boolean {
  return Boolean(body.website && body.website.length > 0);
}

// --- Per-IP cooldown -----------------------------------------------------------------

/** One callback per IP per minute. */
export const CALLBACK_COOLDOWN_MS = 60_000;

/** Above this many tracked IPs the map is swept of expired entries. */
export const MAX_TRACKED_KEYS = 1000;

/**
 * In-memory cooldown: one accepted request per key per window.
 *
 * The site runs as one long-lived Node server in a Docker container, so a process
 * Map is enough here. A refused request does not restart the window, so a client
 * that keeps retrying gets through once the minute from its last accepted call is
 * over. The map is swept only when it grows past `maxKeys`, which keeps memory
 * bounded without a timer.
 */
export function createCooldownLimiter({
  windowMs = CALLBACK_COOLDOWN_MS,
  maxKeys = MAX_TRACKED_KEYS,
  now = Date.now,
}: { windowMs?: number; maxKeys?: number; now?: () => number } = {}) {
  const lastAccepted = new Map<string, number>();

  return {
    /** True if the request may go ahead. Records it as the key's last accepted call. */
    tryAcquire(key: string): boolean {
      const t = now();
      const last = lastAccepted.get(key);
      if (last !== undefined && t - last < windowMs) return false;
      lastAccepted.set(key, t);
      if (lastAccepted.size > maxKeys) {
        for (const [k, ts] of lastAccepted) {
          if (t - ts > windowMs) lastAccepted.delete(k);
        }
      }
      return true;
    },
    get size(): number {
      return lastAccepted.size;
    },
  };
}

// --- n8n webhook ---------------------------------------------------------------------

export const WEBHOOK_TIMEOUT_MS = 8000;

export type CallbackWebhookConfig = {
  /** N8N_CALLBACK_WEBHOOK_URL. Without it the callback is switched off. */
  url: string | undefined;
  /** N8N_CALLBACK_WEBHOOK_TOKEN, for a webhook node with header auth. Optional. */
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/**
 * Asks n8n to start the phone call. Returns whether n8n accepted it.
 *
 * Never throws: a missing URL, a network error, a timeout or a non-2xx answer all
 * give false. The form then tells the visitor the request was received, without
 * promising an instant call.
 */
export async function triggerCallback(
  phone: string,
  source: string,
  { url, token, fetchImpl = fetch, now = Date.now }: CallbackWebhookConfig,
): Promise<boolean> {
  if (!url) return false;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ phone, source, ts: now() }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
