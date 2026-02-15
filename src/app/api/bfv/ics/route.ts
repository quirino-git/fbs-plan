import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");

  if (!url) {
    return NextResponse.json({ error: "Parameter 'url' fehlt" }, { status: 400 });
  }

  // Minimaler Schutz gegen SSRF: nur BFV/service URLs erlauben
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "Ungültige URL" }, { status: 400 });
  }

  const host = parsed.host.toLowerCase();
  const allowedHosts = new Set(["service.bfv.de", "www.bfv.de"]);
  if (![...allowedHosts].some((h) => host === h || host.endsWith("." + h))) {
    return NextResponse.json({ error: "Host nicht erlaubt" }, { status: 400 });
  }

  const res = await fetch(url, {
    headers: { "user-agent": "FCSternPitchPlanner/1.0" },
    cache: "no-store",
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return NextResponse.json(
      { error: "BFV fetch failed", status: res.status, text: txt },
      { status: 502 }
    );
  }

  const ics = await res.text();
  return new NextResponse(ics, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "no-store, no-cache, max-age=0, must-revalidate",
      pragma: "no-cache",
    },
  });
}