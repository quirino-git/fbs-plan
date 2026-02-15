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

type Pitch = { id: string; name: string; type: "GROSSFELD" | "KOMPAKT" };
type Team = { id: string; name: string; age_u: number };

type BfvClub = { id: string; name: string };
type BfvTeam = {
  id: string;
  club_id: string;
  name: string;
  age_u: number | null;
  ics_url: string | null;
  home_only: boolean | null;
};

type Booking = {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  note: string | null;
  team_id: string;
  pitch_id: string;
  created_by?: string | null;
};

type IcsGame = {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  location?: string | null;
  isHome?: boolean | null; // true/false/unknown
};

function fmtDateDE(d: Date) {
  return d.toLocaleDateString("de-DE");
}
function fmtTimeDE(d: Date) {
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function unfoldIcsLines(raw: string) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.trimStart();
    else out.push(line);
  }
  return out;
}

function parseIcs(icsText: string): IcsGame[] {
  const lines = unfoldIcsLines(icsText);

  const games: IcsGame[] = [];
  let inEvent = false;

  let uid = "";
  let summary = "";
  let location = "";
  let dtStart: Date | null = null;
  let dtEnd: Date | null = null;

  const parseDt = (v: string) => {
    // BFV liefert typischerweise UTC: 20260222T140000Z
    const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (!m) return null;
    const [_, Y, Mo, D, H, Mi, S, z] = m;
    if (z) return new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S));
    return new Date(+Y, +Mo - 1, +D, +H, +Mi, +S);
  };

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      inEvent = true;
      uid = "";
      summary = "";
      location = "";
      dtStart = null;
      dtEnd = null;
      continue;
    }
    if (line.startsWith("END:VEVENT")) {
      if (inEvent && uid && summary && dtStart && dtEnd) {
        games.push({
          uid,
          summary,
          start: dtStart,
          end: dtEnd,
          location: location || null,
          isHome: null,
        });
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;

    if (line.startsWith("UID:")) uid = line.slice(4).trim();
    else if (line.startsWith("SUMMARY:")) summary = line.slice(8).trim();
    else if (line.startsWith("LOCATION:")) location = line.slice(9).trim();
    else if (line.startsWith("DTSTART")) {
      const v = line.split(":").slice(1).join(":").trim();
      dtStart = parseDt(v);
    } else if (line.startsWith("DTEND")) {
      const v = line.split(":").slice(1).join(":").trim();
      dtEnd = parseDt(v);
    }
  }

  return games;
}

/** Normalisiert für robustes "contains"-Matching (umlaute, sonderzeichen, mehrfach-spaces). */
function normalizeForMatch(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "fc",
  "tsv",
  "sv",
  "sc",
  "sg",
  "jfg",
  "ev",
  "e",
  "v",
  "muenchen",
  "munchen",
  "muench",
  "m",
  "ii",
  "iii",
  "iv",
  "i",
  "u",
  "junioren",
  "juniorinnen",
]);

function buildMatchTokens(...names: string[]) {
  const tokens: string[] = [];
  for (const n of names) {
    const norm = normalizeForMatch(n);
    for (const w of norm.split(" ")) {
      if (!w) continue;
      if (STOPWORDS.has(w)) continue;
      if (/^u\d{1,2}$/.test(w)) continue;
      if (w.length < 3) continue;
      tokens.push(w);
    }
  }
  return Array.from(new Set(tokens));
}

function splitHomeAway(summary: string): { left: string; right: string } | null {
  const teamPart = summary.split(",")[0] || summary;

  if (teamPart.includes(" - ")) {
    const [l, r] = teamPart.split(" - ");
    if (l && r) return { left: l.trim(), right: r.trim() };
  }
  if (teamPart.includes(" – ")) {
    const [l, r] = teamPart.split(" – ");
    if (l && r) return { left: l.trim(), right: r.trim() };
  }

  const m = teamPart.match(/^(.*?)[\s]*[-–][\s]*(.*)$/);
  if (m?.[1] && m?.[2]) return { left: m[1].trim(), right: m[2].trim() };

  return null;
}

function findBfvUid(note: string | null) {
  if (!note) return null;
  const m = note.match(/\[BFV_UID:([^\]]+)\]/i);
  return m ? m[1] : null;
}

export default function BfvPage() {
  const enableBFV = String(process.env.NEXT_PUBLIC_ENABLE_BFV || "").toLowerCase() === "true";

  const [sessionChecked, setSessionChecked] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);

  const [clubs, setClubs] = useState<BfvClub[]>([]);
  const [bfvTeams, setBfvTeams] = useState<BfvTeam[]>([]);

  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);

  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [selectedBfvTeamId, setSelectedBfvTeamId] = useState<string>("");

  const [homeOnly, setHomeOnly] = useState(true);
  const [games, setGames] = useState<IcsGame[]>([]);
  const [range, setRange] = useState<{ start: Date; end: Date } | null>(null);

  const [bookedMap, setBookedMap] = useState<Record<string, string>>({}); // uid -> bookingId
  const [bookedPitchByUid, setBookedPitchByUid] = useState<Record<string, string>>({}); // uid -> pitchId
  const [selectedPitchByUid, setSelectedPitchByUid] = useState<Record<string, string>>({});

  const [error, setError] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [loadingGames, setLoadingGames] = useState(false);

  const isAdmin = useMemo(() => (profile?.role || "TRAINER").toUpperCase() === "ADMIN", [profile]);

  const pitchNameById = useMemo(() => new Map(pitches.map((p) => [p.id, p.name])), [pitches]);

  // UI sizing (Button ≈ Dropdown)
  const CONTROL_H = 36;
  const selectStyle: React.CSSProperties = {
    minWidth: 280,
    height: CONTROL_H,
    padding: "0 10px",
    borderRadius: 10,
  };
  const actionBtnStyle: React.CSSProperties = {
    height: CONTROL_H,
    padding: "0 12px",
    borderRadius: 12,
    fontWeight: 800,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    whiteSpace: "nowrap",
  };

  // ---------- Session/Profile ----------
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;

      if (!session) {
        window.location.href = "/login";
        return;
      }

      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("id,full_name,role,active")
        .eq("id", session.user.id)
        .maybeSingle();

      if (profErr) {
        console.error(profErr);
        setProfile(null);
      } else {
        setProfile((prof ?? null) as Profile | null);
      }

      setSessionChecked(true);
    })();
  }, []);

  // ---------- Base data ----------
  useEffect(() => {
    if (!sessionChecked) return;

    (async () => {
      setError(null);

      const [clubsRes, teamsRes, pitchesRes, localTeamsRes] = await Promise.all([
        supabase.from("bfv_clubs").select("id,name").order("name"),
        supabase.from("bfv_teams").select("id,club_id,name,age_u,ics_url,home_only").order("name"),
        supabase.from("pitches").select("id,name,type").order("name"),
        supabase.from("teams").select("id,name,age_u").order("age_u").order("name"),
      ]);

      if (clubsRes.error) return setError(clubsRes.error.message);
      if (teamsRes.error) return setError(teamsRes.error.message);
      if (pitchesRes.error) return setError(pitchesRes.error.message);
      if (localTeamsRes.error) return setError(localTeamsRes.error.message);

      setClubs((clubsRes.data ?? []) as BfvClub[]);
      setBfvTeams((teamsRes.data ?? []) as BfvTeam[]);
      setPitches((pitchesRes.data ?? []) as Pitch[]);
      setTeams((localTeamsRes.data ?? []) as Team[]);

      const firstClub = (clubsRes.data ?? [])[0] as BfvClub | undefined;
      if (firstClub?.id) setSelectedClubId(firstClub.id);
    })();
  }, [sessionChecked]);

  const selectedClub = useMemo(() => clubs.find((c) => c.id === selectedClubId) ?? null, [clubs, selectedClubId]);

  const teamsForClub = useMemo(() => bfvTeams.filter((t) => t.club_id === selectedClubId), [bfvTeams, selectedClubId]);

  const selectedBfvTeam = useMemo(
    () => teamsForClub.find((t) => t.id === selectedBfvTeamId) ?? null,
    [teamsForClub, selectedBfvTeamId]
  );

  // wenn Verein wechselt: erste Mannschaft auswählen
  useEffect(() => {
    if (!selectedClubId) return;
    const first = teamsForClub[0];
    if (first?.id) setSelectedBfvTeamId(first.id);
  }, [selectedClubId, teamsForClub]);

  // homeOnly default aus bfv_teams übernehmen
  useEffect(() => {
    if (!selectedBfvTeam) return;
    if (typeof selectedBfvTeam.home_only === "boolean") setHomeOnly(selectedBfvTeam.home_only);
  }, [selectedBfvTeam?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Availability ----------
  const BLOCKING_STATUSES = useMemo(() => new Set(["REQUESTED", "APPROVED"]), []);

  function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
    return aStart < bEnd && bStart < aEnd;
  }

  function allowedPitchesForAge(ageU: number | null) {
    // ab U14: nur Großfeld Mitte+Rechts
    if (ageU != null && ageU >= 14) {
      return pitches.filter((p) => {
        const n = (p.name || "").toLowerCase();
        return p.type === "GROSSFELD" && (n.includes("mitte") || n.includes("rechts"));
      });
    }
    return pitches; // U7-U13 -> alle
  }

  function getAvailablePitches(game: IcsGame, bookingsList: Booking[] = bookings) {
    const candidates = allowedPitchesForAge(selectedBfvTeam?.age_u ?? null);
    const gStart = game.start;
    const gEnd = game.end;

    const blockingBookings = bookingsList.filter((b) => BLOCKING_STATUSES.has(String(b.status || "").toUpperCase()));

    return candidates.filter((p) => {
      const collision = blockingBookings.some((b) => {
        if (b.pitch_id !== p.id) return false;
        return overlaps(gStart, gEnd, new Date(b.start_at), new Date(b.end_at));
      });
      return !collision;
    });
  }

  // ---------- Bookings fetch + maps ----------
  async function loadBookingsForRange(rangeStart: Date, rangeEnd: Date) {
    const startISO = rangeStart.toISOString();
    const endISO = rangeEnd.toISOString();

    const { data, error } = await supabase
      .from("bookings")
      .select("id,start_at,end_at,status,note,team_id,pitch_id,created_by")
      .gte("start_at", startISO)
      .lt("end_at", endISO);

    if (error) throw error;

    const list = (data ?? []) as Booking[];
    setBookings(list);

    const uidToBookingId: Record<string, string> = {};
    const uidToPitchId: Record<string, string> = {};
    for (const b of list) {
      const uid = findBfvUid(b.note);
      if (!uid) continue;
      uidToBookingId[uid] = b.id;
      uidToPitchId[uid] = b.pitch_id;
    }
    setBookedMap(uidToBookingId);
    setBookedPitchByUid(uidToPitchId);

    return { list, uidToBookingId, uidToPitchId };
  }

  // ---------- Local team mapping ----------
  function resolveLocalTeamId() {
    const targetAge = selectedBfvTeam?.age_u ?? null;

    if (targetAge != null) {
      const best = teams.find((t) => t.age_u === targetAge);
      if (best?.id) return best.id;
    }

    const bfvName = (selectedBfvTeam?.name || "").toLowerCase();
    const byName = teams.find((t) => (t.name || "").toLowerCase().includes(bfvName));
    return byName?.id ?? null;
  }

  // ---------- Load games ----------
  async function loadGames() {
    if (!selectedBfvTeam?.id) return;

    setLoadingGames(true);
    setError(null);

    try {
      const url = selectedBfvTeam?.ics_url;
      if (!url) throw new Error("Für diese Mannschaft ist kein ICS-Link hinterlegt.");

      const res = await fetch(`/api/bfv/ics?url=${encodeURIComponent(url)}`, { cache: "no-store" });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`ICS fetch failed (${res.status}): ${txt || "—"}`);
      }

      const icsText = await res.text();
      let parsed = parseIcs(icsText);

      // Heim/Auswärts robust bestimmen
      const clubName = selectedClub?.name ?? "";
      const teamName = selectedBfvTeam?.name ?? "";
      const tokens = buildMatchTokens(clubName, teamName);

      parsed = parsed.map((g) => {
        const parts = splitHomeAway(g.summary);
        const locNorm = normalizeForMatch(g.location || "");
        const matchSide = (s: string) => {
          const norm = normalizeForMatch(s);
          return tokens.length ? tokens.some((t) => norm.includes(t)) : false;
        };

        let isHome: boolean | null = null;

        if (parts) {
          const leftMatch = matchSide(parts.left);
          const rightMatch = matchSide(parts.right);

          if (leftMatch && !rightMatch) isHome = true;
          else if (rightMatch && !leftMatch) isHome = false;
          else if (leftMatch && rightMatch) isHome = true;
          else isHome = null;
        } else {
          if (tokens.length && tokens.some((t) => locNorm.includes(t))) isHome = true;
          else isHome = null;
        }

        return { ...g, isHome };
      });

      const filtered = homeOnly ? parsed.filter((g) => g.isHome !== false) : parsed;

      // Range bestimmen
      let min = filtered[0]?.start;
      let max = filtered[0]?.end;
      for (const g of filtered) {
        if (!min || g.start < min) min = g.start;
        if (!max || g.end > max) max = g.end;
      }

      const rangeStart = min ? new Date(min) : new Date();
      const rangeEnd = max ? new Date(max) : new Date(new Date().getTime() + 1000 * 60 * 60 * 24 * 30);
      setRange({ start: rangeStart, end: rangeEnd });

      const { list: bookingList, uidToPitchId } = await loadBookingsForRange(rangeStart, rangeEnd);

      // Default pitch selection:
      // - wenn schon gebucht: den gebuchten Platz setzen
      // - sonst: ersten freien Platz setzen
      const defaults: Record<string, string> = {};
      for (const g of filtered) {
        const bookedPitch = uidToPitchId[g.uid];
        if (bookedPitch) {
          defaults[g.uid] = bookedPitch;
          continue;
        }
        const avail = getAvailablePitches(g, bookingList);
        if (avail[0]) defaults[g.uid] = avail[0].id;
      }
      setSelectedPitchByUid((prev) => ({ ...prev, ...defaults }));

      setGames(filtered);
    } catch (e: any) {
      console.error(e);
      setGames([]);
      setError(e?.message || "Fehler beim Laden der Spiele.");
    } finally {
      setLoadingGames(false);
    }
  }

  useEffect(() => {
    if (!sessionChecked) return;
    if (!enableBFV) return;
    if (!isAdmin) return;
    if (!selectedBfvTeam?.id) return;

    loadGames();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionChecked, enableBFV, isAdmin, selectedBfvTeam?.id, homeOnly]);

  // ---------- Book / Undo ----------
  async function bookApproved(game: IcsGame, pitchId: string) {
    setBusyUid(game.uid);
    setError(null);

    try {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user?.id;
      if (!uid) throw new Error("Session fehlt – bitte neu einloggen.");

      const localTeamId = resolveLocalTeamId();
      if (!localTeamId) {
        throw new Error("Konnte keine passende lokale Mannschaft (teams) finden. Bitte 'teams' prüfen.");
      }

      const note = `[BFV] ${game.summary}\n[BFV_UID:${game.uid}]`;

      const { data: ins, error: insErr } = await supabase
        .from("bookings")
        .insert({
          start_at: game.start.toISOString(),
          end_at: game.end.toISOString(),
          status: "APPROVED",
          note,
          pitch_id: pitchId,
          team_id: localTeamId,
          created_by: uid,
        })
        .select("id")
        .maybeSingle();

      if (insErr) throw insErr;

      // Nach dem Insert:
      // - maps neu laden, damit "grün" auch nach Reload bleibt
      if (range) await loadBookingsForRange(range.start, range.end);

      // Pitch-Auswahl auf den gebuchten Pitch setzen (UI logisch)
      setSelectedPitchByUid((m) => ({ ...m, [game.uid]: pitchId }));

      if (ins?.id) {
        setBookedMap((m) => ({ ...m, [game.uid]: ins.id }));
        setBookedPitchByUid((m) => ({ ...m, [game.uid]: pitchId }));
      }
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Fehler beim Buchen.");
    } finally {
      setBusyUid(null);
    }
  }

  async function undoBooking(gameUid: string) {
    const bookingId = bookedMap[gameUid];
    if (!bookingId) return;

    setBusyUid(gameUid);
    setError(null);

    try {
      const { error } = await supabase.from("bookings").delete().eq("id", bookingId);
      if (error) throw error;

      // reload bookings/maps
      if (range) {
        const { list: bookingList } = await loadBookingsForRange(range.start, range.end);

        // nach Undo: wieder einen sinnvollen Default-Pitch setzen
        const g = games.find((x) => x.uid === gameUid);
        if (g) {
          const avail = getAvailablePitches(g, bookingList);
          setSelectedPitchByUid((m) => ({ ...m, [gameUid]: avail[0]?.id ?? "" }));
        }
      }

      setBookedMap((m) => {
        const copy = { ...m };
        delete copy[gameUid];
        return copy;
      });
      setBookedPitchByUid((m) => {
        const copy = { ...m };
        delete copy[gameUid];
        return copy;
      });
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Fehler beim Zurücknehmen.");
    } finally {
      setBusyUid(null);
    }
  }

  if (!sessionChecked) return null;

  if (!enableBFV) {
    return (
      <div style={{ maxWidth: 1100, margin: "24px auto", padding: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Ligaspiele planen (BFV)</div>
          <div style={{ marginTop: 10, opacity: 0.85 }}>
            Feature ist deaktiviert. Setze <code>NEXT_PUBLIC_ENABLE_BFV=true</code>.
          </div>
          <div style={{ marginTop: 14 }}>
            <Link href="/calendar" style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #273243" }}>
              ← Kalender
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div style={{ maxWidth: 1100, margin: "24px auto", padding: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Ligaspiele planen (BFV)</div>
          <div style={{ marginTop: 10, opacity: 0.85 }}>Nur für Admin verfügbar.</div>
          <div style={{ marginTop: 14 }}>
            <Link href="/calendar" style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #273243" }}>
              ← Kalender
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const clubName = selectedClub?.name ?? "—";
  const icsUrl = selectedBfvTeam?.ics_url ?? null;

  return (
    <div style={{ maxWidth: 1200, margin: "24px auto", padding: 16 }}>
      <div
        className="card"
        style={{ padding: 16, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 900 }}>Ligaspiele planen (BFV)</div>
          <div style={{ opacity: 0.85, marginTop: 4 }}>{clubName} • iCal Import</div>
        </div>
        <Link
          href="/calendar"
          style={{ padding: "8px 12px", borderRadius: 12, border: "1px solid #273243", textDecoration: "none" }}
        >
          ← Kalender
        </Link>
      </div>

      <div className="card" style={{ marginTop: 12, padding: 16 }}>
        {error && (
          <div style={{ color: "crimson", marginBottom: 10, fontWeight: 600 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "end" }}>
          <div style={{ minWidth: 320 }}>
            <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 6 }}>Verein:</div>
            <select value={selectedClubId} onChange={(e) => setSelectedClubId(e.target.value)} style={{ width: "100%" }}>
              {clubs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ minWidth: 360 }}>
            <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 6 }}>Mannschaft:</div>
            <select
              value={selectedBfvTeamId}
              onChange={(e) => setSelectedBfvTeamId(e.target.value)}
              style={{ width: "100%" }}
            >
              {teamsForClub.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.age_u ? ` (U${t.age_u})` : ""}
                </option>
              ))}
            </select>
          </div>

          <label style={{ display: "flex", gap: 10, alignItems: "center", paddingBottom: 6 }}>
            <input type="checkbox" checked={homeOnly} onChange={(e) => setHomeOnly(e.target.checked)} />
            nur Heimspiele
          </label>

          <button
            onClick={loadGames}
            disabled={loadingGames || !selectedBfvTeamId}
            style={{ ...actionBtnStyle, padding: "0 14px" }}
          >
            {loadingGames ? "Lade…" : "Aktualisieren"}
          </button>

          <div style={{ flex: 1, minWidth: 260, opacity: 0.8, fontSize: 13 }}>
            {icsUrl ? (
              <>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>ICS:</div>
                <div style={{ wordBreak: "break-all" }}>{icsUrl}</div>
              </>
            ) : (
              <div style={{ color: "crimson", fontWeight: 700 }}>Für diese Mannschaft ist kein ICS-Link hinterlegt.</div>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12, padding: 16 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: 10, borderBottom: "1px solid #273243" }}>Datum</th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243" }}>Spiel</th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243" }}>Heim?</th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243" }}>Von</th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243" }}>Bis</th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243" }}>Freie Plätze</th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243" }}>Aktion</th>
              </tr>
            </thead>

            <tbody>
              {games.map((g) => {
                const bookingId = bookedMap[g.uid];
                const isBooked = !!bookingId;
                const busy = busyUid === g.uid;

                const bookedPitchId = bookedPitchByUid[g.uid];
                const bookedPitchName = bookedPitchId ? pitchNameById.get(bookedPitchId) ?? bookedPitchId : null;

                const avail = getAvailablePitches(g);
                const selectedPitch = selectedPitchByUid[g.uid] || (avail[0]?.id ?? "");

                return (
                  <tr key={g.uid}>
                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)", whiteSpace: "nowrap" }}>
                      {fmtDateDE(g.start)}
                    </td>
                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>{g.summary}</td>
                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      {g.isHome === true ? "Ja" : g.isHome === false ? "Nein" : "?"}
                    </td>
                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)", whiteSpace: "nowrap" }}>
                      {fmtTimeDE(g.start)}
                    </td>
                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)", whiteSpace: "nowrap" }}>
                      {fmtTimeDE(g.end)}
                    </td>

                    {/* ✅ Platz-Spalte: gebucht => gebuchten Platz grün anzeigen */}
                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      {isBooked ? (
                        <div
                          style={{
                            height: CONTROL_H,
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "0 12px",
                            borderRadius: 12,
                            border: "1px solid rgba(255,255,255,0.18)",
                            background: "rgba(40, 160, 80, 0.25)",
                            fontWeight: 800,
                            minWidth: 280,
                          }}
                          title={bookedPitchName ?? ""}
                        >
                          {bookedPitchName ?? "Platz gebucht"}
                        </div>
                      ) : avail.length === 0 ? (
                        <span style={{ color: "crimson", fontWeight: 700 }}>keine</span>
                      ) : (
                        <select
                          value={selectedPitch}
                          onChange={(e) => setSelectedPitchByUid((m) => ({ ...m, [g.uid]: e.target.value }))}
                          style={selectStyle}
                        >
                          {avail.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>

                    {/* ✅ Button-Höhe reduziert */}
                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      {isBooked ? (
                        <button
                          disabled={busy}
                          onClick={() => undoBooking(g.uid)}
                          style={{
                            ...actionBtnStyle,
                            cursor: busy ? "not-allowed" : "pointer",
                            border: "1px solid rgba(255,255,255,0.18)",
                            background: "rgba(40, 160, 80, 0.25)",
                          }}
                        >
                          Platz gebucht, zurück nehmen
                        </button>
                      ) : (
                        <button
                          disabled={busy || avail.length === 0 || !selectedPitch}
                          onClick={() => bookApproved(g, selectedPitch)}
                          style={actionBtnStyle}
                        >
                          direkt genehmigt anlegen
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}

              {games.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 14, opacity: 0.8 }}>
                    Keine Spiele gefunden.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 10, opacity: 0.75, fontSize: 13 }}>
          Hinweis: Wenn ein Spiel kollidiert, kommt ein Overlap-Fehler – dann Zeit/Platz anpassen. (Wenn REJECTED/CANCELLED Buchungen trotzdem blocken,
          braucht es zusätzlich den DB-Fix an der Exclusion-Constraint.)
        </div>
      </div>
    </div>
  );
}