import { Suspense } from "react";
import NewRequestClient from "./NewRequestClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function NewRequestPage() {
  return (
    <Suspense fallback={<div style={{ maxWidth: 520, margin: "30px auto", padding: 16 }}>Lade Antrag…</div>}>
      <NewRequestClient />
    </Suspense>
  );
}
