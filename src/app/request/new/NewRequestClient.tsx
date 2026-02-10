"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Pitch = { id: string; name: string };
type Team = { id: string; name: string; age_u: number };

function addMinutesLocal(dtLocal: string, minutes: number) {
  // dtLocal: "YYYY-MM-DDTHH:mm"
  const d = new Date(dtLocal);
  const out = new Date(d.getTime() + minutes * 60 * 1000);

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${out.getFullYear()}-${pad(out.getMonth() + 1)}-${pad(out.getDate())}T${pad(out.getHours())}:${pad(
    out.getMinutes()
  )}`;
}

export default function NewRequestClient() {
  const searchParams = useSearchParams();

  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState("");
  const [pitchId, setPitchId] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  // ✅ Return-to-calendar Link (zur richtigen View/Date zurück)
  const backHref = useMemo(() => {
    const returnView = searchParams.get("returnView") || "timeGridWeek";
    const returnDate = searchParams.get("returnDate"); // YYYY-MM-DD

    const params = new URLSearchParams();
    params.set("view", returnView);
    if (returnDate) params.set("date", returnDate);

    return `/calendar?${params.toString()}`;
  }, [searchParams]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        window.location.href = "/login";
        return;
      }

      // ✅ Start/End aus Kalender übernehmen
      const qsStart = searchParams.get("start"); // "YYYY-MM-DDTHH:mm"
      const qsEnd = searchParams.get("end");

      if (qsStart) setStartAt(qsStart);
      if (qsEnd) setEndAt(qsEnd);

      // wenn nur Start kommt: default 60 Minuten
      if (qsStart && !qsEnd) setEndAt(addMinutesLocal(qsStart, 60));

      // Falls gar keine Zeit (z.B. Klick über +Antrag), optional default setzen:
      // (hier lassen wir es leer, du kannst aber auch "heute 12:00" setzen, wenn du willst)

      const [p, t] = await Promise.all([
        supabase.from("pitches").select("id,name").order("name"),
        supabase.from("teams").select("id,name,age_u").order("age_u").order("name"),
      ]);

      if (p.error) setError(p.error.message);
      else setPitches(p.data ?? []);

      if (t.error) setError(t.error.message);
      else setTeams(t.data ?? []);
    })();
  }, [searchParams]);

  // ✅ Ende muss nach Start liegen (min. 30 Minuten)
  useEffect(() => {
    if (!startAt) return;

    if (!endAt) {
      setEndAt(addMinutesLocal(startAt, 30));
      return;
    }

    const s = new Date(startAt).getTime();
    const e = new Date(endAt).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;

    if (e <= s) setEndAt(addMinutesLocal(startAt, 30));
  }, [startAt]); // bewusst nur startAt

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);

    const { data: s } = await supabase.auth.getSession();
    const userId = s.session?.user.id;
    if (!userId) {
      window.location.href = "/login";
      return;
    }

    const sTime = new Date(startAt).getTime();
    const eTime = new Date(endAt).getTime();
    if (!startAt || !endAt || !Number.isFinite(sTime) || !Number.isFinite(eTime) || eTime <= sTime) {
      setError("Bitte gültige Start- und Endzeit wählen (Ende muss nach Start liegen).");
      return;
    }

    const { error } = await supabase.from("bookings").insert({
      created_by: userId,
      team_id: teamId,
      pitch_id: pitchId,
      start_at: new Date(startAt).toISOString(),
      end_at: new Date(endAt).toISOString(),
      note: note || null,
      status: "REQUESTED",
    });

    if (error) setError(error.message);
    else {
      setOk(true);
      setNote("");
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
          <input
            type="datetime-local"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
            step={1800} // 30 Min
            required
          />
        </label>

        <label>
          Ende
          <input
            type="datetime-local"
            value={endAt}
            onChange={(e) => setEndAt(e.target.value)}
            step={1800} // 30 Min
            required
          />
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
