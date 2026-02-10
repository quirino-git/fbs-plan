"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter, useSearchParams } from "next/navigation";

type Pitch = { id: string; name: string };
type Team = { id: string; name: string; age_u: number };

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toLocalDateTimeInputValue(d: Date) {
  // YYYY-MM-DDTHH:mm (für <input type="datetime-local">)
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function fromYmd(ymd: string) {
  // ymd = YYYY-MM-DD -> lokales Datum 00:00
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

function addMinutes(d: Date, minutes: number) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() + minutes);
  return x;
}

export default function NewRequestPage() {
  const router = useRouter();
  const sp = useSearchParams();

  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState("");
  const [pitchId, setPitchId] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  // ✅ Return-to-calendar params (ohne window)
  const backHref = useMemo(() => {
    const returnView = sp.get("returnView") || "timeGridWeek";
    const returnDate = sp.get("returnDate"); // YYYY-MM-DD
    const q = new URLSearchParams();
    q.set("view", returnView);
    if (returnDate) q.set("date", returnDate);
    return `/calendar?${q.toString()}`;
  }, [sp]);

  // ✅ Prefill aus Query (start/end oder date)
  useEffect(() => {
    // start/end kommt aus Wochenansicht (Selection/Click)
    const start = sp.get("start"); // ISO oder local string
    const end = sp.get("end");
    const date = sp.get("date"); // YYYY-MM-DD (Monatsklick)

    if (start && end) {
      // Start/Ende direkt übernehmen
      const s = new Date(start);
      const e = new Date(end);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
        setStartAt(toLocalDateTimeInputValue(s));
        setEndAt(toLocalDateTimeInputValue(e));
        return;
      }
    }

    // Monatsansicht: nur Datum -> default 12:00 und 60 Minuten
    if (date) {
      const d0 = fromYmd(date);
      d0.setHours(12, 0, 0, 0);
      const d1 = addMinutes(d0, 60);
      setStartAt(toLocalDateTimeInputValue(d0));
      setEndAt(toLocalDateTimeInputValue(d1));
    }
  }, [sp]);

  // ✅ Session + Stammdaten laden
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        router.replace("/login");
        return;
      }

      const [p, t] = await Promise.all([
        supabase.from("pitches").select("id,name").order("name"),
        supabase.from("teams").select("id,name,age_u").order("age_u").order("name"),
      ]);

      if (p.error) setError(p.error.message);
      else setPitches(p.data ?? []);

      if (t.error) setError(t.error.message);
      else setTeams(t.data ?? []);
    })();
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);

    const { data: s } = await supabase.auth.getSession();
    const userId = s.session?.user.id;
    if (!userId) {
      router.replace("/login");
      return;
    }

    // Basic validation
    if (!teamId || !pitchId || !startAt || !endAt) {
      setError("Bitte alle Felder ausfüllen.");
      return;
    }

    const startISO = new Date(startAt).toISOString();
    const endISO = new Date(endAt).toISOString();

    if (new Date(endAt) <= new Date(startAt)) {
      setError("Ende muss nach Start liegen.");
      return;
    }

    const { error } = await supabase.from("bookings").insert({
      created_by: userId,
      team_id: teamId,
      pitch_id: pitchId,
      start_at: startISO,
      end_at: endISO,
      note: note || null,
      status: "REQUESTED",
    });

    if (error) setError(error.message);
    else {
      setOk(true);
      setNote("");
      // Optional: direkt zurück zum Kalender nach Erfolg
      // router.push(backHref);
    }
  }

  return (
    <div style={{ maxWidth: 520, margin: "30px auto", padding: 16 }}>
      <h1>Neuer Antrag</h1>

      <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
        <label>
          Team
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)} required>
            <option value="" disabled>
              Bitte wählen
            </option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (U{t.age_u})
              </option>
            ))}
          </select>
        </label>

        <label>
          Platz
          <select value={pitchId} onChange={(e) => setPitchId(e.target.value)} required>
            <option value="" disabled>
              Bitte wählen
            </option>
            {pitches.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Start
          <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} required />
        </label>

        <label>
          Ende
          <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} required />
        </label>

        <label>
          Notiz
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </label>

        <button type="submit">Antrag speichern</button>
      </form>

      {ok && <p style={{ color: "green" }}>Antrag erstellt (Status: REQUESTED).</p>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <p style={{ marginTop: 12 }}>
        <a href={backHref}>← zurück zum Kalender</a>
      </p>
    </div>
  );
}
