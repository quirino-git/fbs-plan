import { Suspense } from "react";
import CalendarClient from "./CalendarClient";

// Wichtig: verhindert Static Prerender für diese Seite (weil Auth + window/useSearchParams)
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function CalendarPage() {
  return (
    <Suspense fallback={<div style={{ maxWidth: 1200, margin: "24px auto", padding: 16 }}>Lade Kalender…</div>}>
      <CalendarClient />
    </Suspense>
  );
}
