// supabase/functions/notify-admins/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type WebhookPayload = {
  type?: string; // INSERT | UPDATE | DELETE
  table?: string;
  schema?: string;
  record?: any;
  new_record?: any;
  old_record?: any;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getRecord(payload: WebhookPayload) {
  return payload.record ?? payload.new_record ?? null;
}

serve(async (req) => {
  try {
    // ---- Auth via webhook secret ----
    const expected = Deno.env.get("WEBHOOK_SECRET");
    const got = req.headers.get("x-webhook-secret");

    if (!expected) return json(400, { error: "Missing secret WEBHOOK_SECRET in Edge Function secrets." });
    if (!got || got !== expected) return json(401, { error: "Unauthorized (x-webhook-secret mismatch)." });

    // ---- Secrets ----
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminEmails = (Deno.env.get("ADMIN_EMAILS") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!resendKey) return json(400, { error: "Missing secret RESEND_API_KEY in Edge Function secrets." });
    if (adminEmails.length === 0) return json(400, { error: "Missing/empty ADMIN_EMAILS secret." });

    // ---- Parse payload ----
    let payload: WebhookPayload;
    try {
      payload = (await req.json()) as WebhookPayload;
    } catch (e) {
      return json(400, { error: "Invalid JSON body", detail: String(e) });
    }

    // Optional: only for INSERT on bookings
    const type = (payload.type || "").toUpperCase();
    if (type && type !== "INSERT") {
      return json(200, { ok: true, skipped: `type=${type}` });
    }
    if (payload.table && payload.table !== "bookings") {
      return json(200, { ok: true, skipped: `table=${payload.table}` });
    }

    const rec = getRecord(payload);
    if (!rec) return json(400, { error: "No record/new_record in webhook payload." });

    // ---- Build email ----
    const bookingId = rec.id ?? "(no id)";
    const status = rec.status ?? "(no status)";
    const startAt = rec.start_at ?? "(no start_at)";
    const endAt = rec.end_at ?? "(no end_at)";
    const note = rec.note ?? "";

    const subject = `Neuer Termin-Antrag (${status})`;
    const text =
`Neuer Antrag wurde angelegt.

ID: ${bookingId}
Status: ${status}
Start: ${startAt}
Ende: ${endAt}
Notiz: ${note}
`;

    // ---- Send via Resend ----
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${resendKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: "FC Stern <onboarding@resend.dev>", // für Tests ok; später eigene Domain
        to: adminEmails,
        subject,
        text,
      }),
    });

    const respText = await resp.text();
    if (!resp.ok) {
      console.error("Resend error:", resp.status, respText);
      return json(502, { error: "Resend failed", status: resp.status, detail: respText });
    }

    return json(200, { ok: true });
  } catch (e) {
    console.error("notify-admins crash:", e);
    return json(500, { error: "Internal error", detail: String(e) });
  }
});
