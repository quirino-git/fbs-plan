import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function isAllowedHost(host: string) {
  const h = host.toLowerCase();
  return h === "service.bfv.de" || h === "bfv.de" || h.endsWith(".bfv.de");
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");

  if (!url) {
    return NextResponse.json({ error: "Missing url query param" }, { status: 400 });
  }

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  if (u.protocol !== "https:") {
    return NextResponse.json({ error: "Only https allowed" }, { status: 400 });
  }

  if (!isAllowedHost(u.hostname)) {
    return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
  }

  const res = await fetch(u.toString(), {
    headers: { "user-agent": "FCSternPitchPlanner/1.0" },
    cache: "no-store",
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    return NextResponse.json(
      { error: "BFV fetch failed", status: res.status, text: text.slice(0, 800) },
      { status: 502 }
    );
  }

  return new NextResponse(text, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
