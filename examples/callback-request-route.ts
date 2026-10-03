// Excerpt from the site: POST /api/callback-request (app/api/callback-request/route.ts).
// The visitor leaves a phone number, n8n starts a Voximplant scenario, and the AI
// agent calls the visitor on the phone. Shows how src/callback-request.ts is used.
// Not compiled in this repository: it needs the full Next.js app.
import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_SOURCE,
  callbackRequestSchema,
  createCooldownLimiter,
  isHoneypotFilled,
  triggerCallback,
} from "../src/callback-request.ts";

// One limiter per server process: the site runs as a single Node container.
const limiter = createCooldownLimiter();

function getClientIp(req: NextRequest): string {
  // cf-connecting-ip is set by Cloudflare and cannot be forged by the client.
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!limiter.tryAcquire(ip)) {
    return NextResponse.json({ error: "Too many requests. Try again in a minute." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid format" }, { status: 400 });
  }

  const parsed = callbackRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid phone number" }, { status: 422 });
  }

  // A bot filled the hidden field: look like a success, call nobody.
  if (isHoneypotFilled(parsed.data)) {
    return NextResponse.json({ ok: true, call: false });
  }

  const call = await triggerCallback(parsed.data.phone, parsed.data.source ?? DEFAULT_SOURCE, {
    url: process.env.N8N_CALLBACK_WEBHOOK_URL,
    token: process.env.N8N_CALLBACK_WEBHOOK_TOKEN,
  });

  // `call` tells the form which message to show: "the agent is calling you now"
  // or "thanks, we will get back to you".
  return NextResponse.json({ ok: true, call });
}
