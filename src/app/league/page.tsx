"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  full_name: string | null;
  role: string | null;
  active: boolean | null;
};

export default function LeaguePage() {
  const ENABLE_BFV = process.env.NEXT_PUBLIC_ENABLE_BFV === "true";

  const [sessionChecked, setSessionChecked] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = useMemo(() => (profile?.role || "TRAINER").toUpperCase() === "ADMIN", [profile]);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const session = data.session;

        if (!session) {
          window.location.href = "/login";
          return;
        }

        // Toggle aus? => sofort raus
        if (!ENABLE_BFV) {
          window.location.href = "/calendar";
          return;
        }

        const { data: prof, error: profErr } = await supabase
          .from("profiles")
          .select("id,full_name,role,active")
          .eq("id", session.user.id)
          .maybeSingle();

        if (profErr) {
          setError(profErr.message);
          setProfile(null);
        } else {
          setProfile((prof ?? null) as Profile | null);
        }

        setSessionChecked(true);
      } catch (e: any) {
        setError(e?.message || "Fehler beim Laden.");
        setSessionChecked(true);
      }
    })();
  }, [ENABLE_BFV]);

  // Kein Admin? -> raus
  useEffect(() => {
    if (!sessionChecked) return;
    if (!ENABLE_BFV) return;
    if (!isAdmin) window.location.href = "/calendar";
  }, [sessionChecked, ENABLE_BFV, isAdmin]);

  if (!sessionChecked) return null;
  if (!ENABLE_BFV) return null;
  if (!isAdmin) return null;

  return (
    <div style={{ maxWidth: 1000, margin: "24px auto", padding: 16 }}>
      <div className="card" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Ligaspiele planen</div>
          <div style={{ opacity: 0.8, fontSize: 13 }}>
            (Beta) – hier kommt die BFV-Integration rein. Aktuell nur Platzhalter.
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link href="/calendar" style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #273243" }}>
            ← Kalender
          </Link>
        </div>
      </div>

      {error && <p style={{ color: "crimson", marginTop: 12 }}>{error}</p>}

      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ margin: "0 0 10px 0" }}>Schritt 1: Verein wählen</h2>

        {/* Start bewusst simpel: FC Stern fix als erster Test */}
        <p style={{ opacity: 0.9, margin: 0 }}>
          Starten wir wie besprochen mit <b>FC Stern</b>. Als nächstes bauen wir:
        </p>

        <ol style={{ marginTop: 10, opacity: 0.95 }}>
          <li>Verein (erst FC Stern fix, später Suche)</li>
          <li>Mannschaft / Jahrgang (BFV-Auswahl)</li>
          <li>Spieltermine der laufenden Saison laden</li>
          <li>Spiel auswählen → passende Plätze/Regeln anzeigen → „Einbuchen“</li>
        </ol>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button disabled style={{ opacity: 0.6 }}>
            FC Stern (kommt als nächstes)
          </button>
          <button disabled style={{ opacity: 0.6 }}>
            Verein suchen (später)
          </button>
        </div>
      </div>
    </div>
  );
}
