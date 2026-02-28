"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  full_name: string | null;
  role: string | null;
  active: boolean | null;
};

type Pitch = {
  id: string;
  name: string;
  type: "GROSSFELD" | "KOMPAKT";
  // optional: some queries fetch this from DB
  capacity_units?: number | null;
};
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

type BookingTeam = { age_u: number | null; name?: string | null };

type Booking = {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  note: string | null;
  team_id: string;
  pitch_id: string;
  created_by?: string | null;
  // joined from teams via FK (optional, depending on select)
  // Supabase relations can come back as object OR array depending on how the
  // relationship is defined in PostgREST. We support both.
  team?: BookingTeam | BookingTeam[] | null;
};

type IcsGame = {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  location?: string | null;
  isHome?: boolean | null; // true/false/unknown
};

type GameRow = IcsGame & {
  bfvTeamId: string;
  bfvTeamName: string;
  bfvClubId: string;
  bfvClubName: string;
  bfvAgeU: number | null;
  bfvAgeSource: "teams" | "bfv_teams" | "none";
  icsUrl: string;
};

const FORCE_PREFIX = "FORCE:";
const SEP_VALUE = "__SEP__";

function bookingTeamAgeU(b: Booking): number | null {
  const t = (b as any).team as Booking["team"];
  const obj = Array.isArray(t) ? t[0] : t;
  return obj && typeof (obj as any).age_u === "number" ? (obj as any).age_u : null;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// Supabase returns timestamptz fields as ISO strings by default.
// For date arithmetic/comparisons we convert them to Date objects.
function toDate(iso: string): Date {
  // Be tolerant if we ever get a non-string at runtime.
  const s = typeof iso === "string" ? iso : String(iso);
  return new Date(s);
}
function toYMDLocal(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDateDE(d: Date) {
  return d.toLocaleDateString("de-DE");
}
function fmtTimeDE(d: Date) {
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}


function normalizeTeamName(name: string) {
  return (name || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\./g, "")
    .replace(/\s*-\s*/g, "-")
    .trim();
}

function toULabel(ageU: number | null | undefined): number | null {
  return typeof ageU === "number" ? ageU + 1 : null;
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
        // BFV liefert teils "SPIELFREI"-Einträge. Diese sollen nicht in der Planung auftauchen.
        const sum = summary.toLowerCase();
        if (!sum.includes("spielfrei")) {
          games.push({
            uid,
            summary,
            start: dtStart,
            end: dtEnd,
            location: location || null,
            isHome: null,
          });
        }
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

function isHomeLocation(loc?: string | null): boolean {
  // BFV: "Heimspiel" im Kontext dieser App = Spiel findet an der Feldbergstraße statt
  const n = normalizeForMatch(loc ?? "");
  return n.includes("feldbergstr"); // match Feldbergstr, Feldbergstraße, Feldbergstrasse, Feldbergstr.
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

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });

  await Promise.all(workers);
  return results;
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

  // Altersquelle (nur eine nutzen, um Logik stabil zu halten)
  // Default: "teams" (dort ist age_u laut dir vollständig gepflegt)
  const AGE_SOURCE: "teams" | "bfv_teams" =
    process.env.NEXT_PUBLIC_AGE_SOURCE === "bfv_teams" ? "bfv_teams" : "teams";

  const ageMapTeams = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const t of teams) {
      m.set(normalizeTeamName(t.name), typeof t.age_u === "number" ? t.age_u : null);
    }
    return m;
  }, [teams]);

  const ageMapBfv = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const t of bfvTeams) {
      m.set(normalizeTeamName(t.name), typeof t.age_u === "number" ? t.age_u : null);
    }
    return m;
  }, [bfvTeams]);

  function resolveAgeU(team: BfvTeam): { ageU: number | null; source: "teams" | "bfv_teams" | "none" } {
    const key = normalizeTeamName(team.name);
    if (AGE_SOURCE === "teams") {
      const v = ageMapTeams.get(key);
      return typeof v === "number" ? { ageU: v, source: "teams" } : { ageU: null, source: "none" };
    }
    const v = ageMapBfv.get(key);
    return typeof v === "number" ? { ageU: v, source: "bfv_teams" } : { ageU: null, source: "none" };
  }

  const missingAgeCount = useMemo(() => {
    let c = 0;
    for (const t of bfvTeams) {
      const r = resolveAgeU(t);
      if (r.ageU == null) c++;
    }
    return c;
  }, [bfvTeams, ageMapTeams, ageMapBfv]);


  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [selectedBfvTeamId, setSelectedBfvTeamId] = useState<string>("");

  // ✅ Tagesplanung
  const [dayPlanDate, setDayPlanDate] = useState<string>(""); // YYYY-MM-DD
  const isDayPlanning = dayPlanDate.trim().length > 0;

  const prevSingleSelection = useRef<{ clubId: string; teamId: string }>({ clubId: "", teamId: "" });

  const [homeOnly, setHomeOnly] = useState(true);
  const [games, setGames] = useState<GameRow[]>([]);
  const [range, setRange] = useState<{ start: Date; end: Date } | null>(null);

  const [bookedMap, setBookedMap] = useState<Record<string, string>>({}); // uid -> bookingId
  const [bookedPitchMap, setBookedPitchMap] = useState<Record<string, string>>({}); // uid -> pitchId
  const [bookedForcedMap, setBookedForcedMap] = useState<Record<string, boolean>>({}); // uid -> forced overlap?
  const [selectedPitchByUid, setSelectedPitchByUid] = useState<Record<string, string>>({});

  const [error, setError] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [loadingGames, setLoadingGames] = useState(false);

  const isAdmin = useMemo(() => (profile?.role || "TRAINER").toUpperCase() === "ADMIN", [profile]);

  const isBusy = busyUid !== null || loadingGames;

  function selectionIsForced(value: string | undefined) {
    return !!value && value.startsWith(FORCE_PREFIX);
  }

  function parsePitchSelection(value: string): { pitchId: string; forceOverlap: boolean } {
    const forceOverlap = value.startsWith(FORCE_PREFIX);
    const pitchId = forceOverlap ? value.slice(FORCE_PREFIX.length) : value;
    return { pitchId, forceOverlap };
  }

  const clubsById = useMemo(() => new Map(clubs.map((c) => [c.id, c.name])), [clubs]);
  const pitchesById = useMemo(() => new Map(pitches.map((p) => [p.id, p])), [pitches]);

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
      if (firstClub?.id) {
        setSelectedClubId(firstClub.id);
        prevSingleSelection.current.clubId = firstClub.id;
      }
    })();
  }, [sessionChecked]);

  const teamsForClub = useMemo(
    () => bfvTeams.filter((t) => t.club_id === selectedClubId),
    [bfvTeams, selectedClubId]
  );

  const selectedClub = useMemo(() => clubs.find((c) => c.id === selectedClubId) ?? null, [clubs, selectedClubId]);

  const selectedBfvTeam = useMemo(
    () => teamsForClub.find((t) => t.id === selectedBfvTeamId) ?? null,
    [teamsForClub, selectedBfvTeamId]
  );

  // Wenn Verein wechselt: erste Mannschaft auswählen (nur in Einzelplanung)
  useEffect(() => {
    if (!selectedClubId) return;
    if (isDayPlanning) return;

    const first = teamsForClub[0];
    if (first?.id) {
      setSelectedBfvTeamId(first.id);
      prevSingleSelection.current = { clubId: selectedClubId, teamId: first.id };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClubId, teamsForClub]);

  // homeOnly default aus bfv_teams übernehmen (nur in Einzelplanung)
  useEffect(() => {
    if (isDayPlanning) return;
    if (!selectedBfvTeam) return;
    if (typeof selectedBfvTeam.home_only === "boolean") setHomeOnly(selectedBfvTeam.home_only);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBfvTeam?.id, isDayPlanning]);

  // ---------- Tagesplanung: Dropdowns leer anzeigen ----------
  useEffect(() => {
    if (!sessionChecked) return;

    if (isDayPlanning) {
      // Merken, was vorher selektiert war, und dann "leer" machen
      if (selectedClubId || selectedBfvTeamId) {
        prevSingleSelection.current = { clubId: selectedClubId, teamId: selectedBfvTeamId };
      }
      setSelectedClubId("");
      setSelectedBfvTeamId("");
    } else {
      // Restore
      const prev = prevSingleSelection.current;
      if (prev.clubId) setSelectedClubId(prev.clubId);
      if (prev.teamId) setSelectedBfvTeamId(prev.teamId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDayPlanning]);

  // ---------- Bookings fetch + bookedMap rebuild ----------
  const BLOCKING_STATUSES = useMemo(() => new Set(["REQUESTED", "APPROVED"]), []);

  async function loadBookingsForRange(rangeStart: Date, rangeEnd: Date) {
    const startISO = rangeStart.toISOString();
    const endISO = rangeEnd.toISOString();

    const { data, error } = await supabase
      .from("bookings")
      .select("id,start_at,end_at,status,note,team_id,pitch_id,created_by,team:team_id(age_u,name)")
      .gte("start_at", startISO)
      .lt("end_at", endISO);

    if (error) throw error;

    const list = (data ?? []) as Booking[];
    setBookings(list);

    const map: Record<string, string> = {};
    const pitchMap: Record<string, string> = {};
    const forcedMap: Record<string, boolean> = {};

    for (const b of list) {
      const uid = findBfvUid(b.note);
      if (!uid) continue;

      const st = String(b.status || "").toUpperCase();
      // Nur REQUESTED/APPROVED als "gebucht" zählen
      if (!BLOCKING_STATUSES.has(st)) continue;

      map[uid] = b.id;
      pitchMap[uid] = b.pitch_id;
      forcedMap[uid] = Boolean((b as any).force_overlap) || String(b.note || "").includes("[FORCE_OVERLAP:true]");
    }

    setBookedMap(map);
    setBookedPitchMap(pitchMap);
    setBookedForcedMap(forcedMap);

    return list;
  }

  // ---------- Local team mapping ----------
  function resolveLocalTeamIdFor(bfvTeam: { age_u: number | null; name: string }) {
    const targetAge = bfvTeam.age_u ?? null;

    if (targetAge != null) {
      const best = teams.find((t) => t.age_u === targetAge);
      if (best?.id) return best.id;
    }

    const bfvName = (bfvTeam.name || "").toLowerCase();
    const byName = teams.find((t) => (t.name || "").toLowerCase().includes(bfvName));
    return byName?.id ?? null;
  }

  // ---------- Availability ----------
  function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
    return aStart < bEnd && bStart < aEnd;
  }

  function allowedPitchesForAge(ageU: number | null) {
    // WICHTIG: age_u ist in unserem Datenmodell um 1 verschoben (U9 -> 8).
    // Deshalb immer mit dem "U-Label" arbeiten.
    const uLabel = toULabel(ageU);

    // Grob-Filter für die UI:
    // - U14+ (oder unbekannt): kein Kompaktfeld
    // - bis inkl. U13: alle Plätze anzeigen
    //   (die Kombinations-/Exklusivregeln werden in isAvailable geprüft)
    if (uLabel == null || uLabel >= 14) return pitches.filter((p) => p.type !== "KOMPAKT");
    return pitches;
  }


  function getAvailablePitches(game: GameRow) {
    const candidates = allowedPitchesForAge(game.bfvAgeU);

    const gStart = game.start;
    const gEnd = game.end;

    const gameULabel = toULabel(game.bfvAgeU);
    const isUnknown = gameULabel == null;
    const isU12orYounger = gameULabel != null ? gameULabel <= 12 : false;
    const isU13 = gameULabel === 13;
    const isU14Plus = gameULabel != null ? gameULabel >= 14 : false;

    const blockingBookings = bookings.filter(
      (b) =>
        BLOCKING_STATUSES.has(String(b.status)) &&
        toDate(b.start_at) < gEnd &&
        toDate(b.end_at) > gStart
    );

    function bookingULabel(b: Booking): number | null {
      return toULabel(bookingTeamAgeU(b));
    }

    function overlapsForPitch(pitchId: string) {
      return blockingBookings.filter((b) => b.pitch_id === pitchId);
    }

    function isAvailable(p: Pitch) {
      const ovs = overlapsForPitch(p.id);

      const overlapsAnyU13Plus = ovs.some((b) => {
        const u = bookingULabel(b);
        return u == null ? true : u >= 13;
      });

      // -----------------
      // KOMPAKTFELD Regeln
      // -----------------
      if (p.type === "KOMPAKT") {
        // U14+ oder unbekannt: darf nicht aufs Kompaktfeld (außer Force-Option im UI)
        if (isUnknown || isU14Plus) return false;

        // U13: darf Kompaktfeld, aber nur exklusiv (keine Kombination mit anderen)
        if (isU13) return ovs.length === 0;

        // <=U12: bis zu 2 parallele, aber nur mit <=U12
        if (isU12orYounger) {
          if (overlapsAnyU13Plus) return false; // keine Mischung <=U12 mit U13+
          return ovs.length < 2;
        }

        return false;
      }

      // -----------------
      // GROSSFELD / RASEN Regeln
      // -----------------
      // Ab U13 (inkl.) und unbekannt: exklusiv (keine weiteren überlappenden Buchungen)
      if (isUnknown || isU13 || isU14Plus) {
        return ovs.length === 0;
      }

      // <=U12: bis zu 2 parallele, aber nur wenn auch die Overlaps <=U12 sind
      if (isU12orYounger) {
        if (overlapsAnyU13Plus) return false;
        return ovs.length < 2;
      }

      return ovs.length === 0;
    }

    return candidates.filter(isAvailable);
  }


  // ---------- Home/Away marker ----------
  function addHomeInfo(rawGames: IcsGame[], clubName: string, teamName: string) {
    // Heimspiele (für diese App) = Spiele, deren ICS-LOCATION die Feldbergstraße enthält.
    // Damit vermeiden wir falsche Heimspiel-Erkennung über Team-/Vereinsnamen.
    // clubName/teamName bleiben als Parameter (falls wir das später erweitern wollen).
    return rawGames.map((g) => {
      // Heimspiel ausschließlich über LOCATION (Feldbergstraße) bestimmen.
      // Wenn LOCATION fehlt, behandeln wir es als "nicht Heim", damit keine falschen Heimspiele entstehen.
      const isHome = isHomeLocation(g.location);
      return { ...g, isHome };
    });
  }

// ---------- Load games (single) ----------
  async function loadGamesSingle(team: BfvTeam, clubName: string) {
    const url = team.ics_url;
    if (!url) throw new Error("Für diese Mannschaft ist kein ICS-Link hinterlegt.");

    const res = await fetch(`/api/bfv/ics?url=${encodeURIComponent(url)}`, { cache: "no-store" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`ICS fetch failed (${res.status}): ${txt || "—"}`);
    }

    const icsText = await res.text();
    let parsed = parseIcs(icsText);
    parsed = addHomeInfo(parsed, clubName, team.name);

    // Filter (nur Feldbergstraße/Heimspiele): nur g.isHome === true
    const filtered = homeOnly ? parsed.filter((g) => g.isHome === true) : parsed;

    const rows: GameRow[] = filtered.map((g) => {
      const r = resolveAgeU(team);
      return {
        ...g,
        bfvTeamId: team.id,
        bfvTeamName: team.name,
        bfvClubId: team.club_id,
        bfvClubName: clubName,
        bfvAgeU: r.ageU,
        bfvAgeSource: r.source,
        icsUrl: url,
      };
    });

    // Range bestimmen
    let min = rows[0]?.start;
    let max = rows[0]?.end;
    for (const g of rows) {
      if (!min || g.start < min) min = g.start;
      if (!max || g.end > max) max = g.end;
    }
    const rangeStart = min ? new Date(min) : new Date();
    const rangeEnd = max ? new Date(max) : new Date(new Date().getTime() + 1000 * 60 * 60 * 24 * 30);
    setRange({ start: rangeStart, end: rangeEnd });

    await loadBookingsForRange(rangeStart, rangeEnd);

    // Defaults: gebucht -> gebuchter Platz, sonst erster freier
    const defaults: Record<string, string> = {};
    for (const g of rows) {
      const bookedPitch = bookedPitchMap[g.uid];
      if (bookedPitch) {
        defaults[g.uid] = bookedPitch;
      } else {
        const avail = getAvailablePitches(g);
        if (avail[0]) defaults[g.uid] = avail[0].id;
      }
    }
    setSelectedPitchByUid(defaults);

    // Sort by start
    rows.sort((a, b) => a.start.getTime() - b.start.getTime());

    setGames(rows);
  }

  // ---------- Load games (day planning) ----------
  async function loadGamesDay(dayStr: string) {
    const teamsWithIcs = bfvTeams.filter((t) => !!t.ics_url);

    if (teamsWithIcs.length === 0) {
      setGames([]);
      throw new Error("Es gibt keine Mannschaften mit ICS-Link (bfv_teams.ics_url).");
    }

    const startDayLocal = new Date(`${dayStr}T00:00:00`);
    const endDayLocal = new Date(startDayLocal);
    endDayLocal.setDate(endDayLocal.getDate() + 1);

    setRange({ start: startDayLocal, end: endDayLocal });

    // Bookings des Tages laden (damit Verfügbarkeiten & bookedMap stimmen)
    await loadBookingsForRange(startDayLocal, endDayLocal);

    const results = await mapLimit(teamsWithIcs, 4, async (t) => {
      const clubName = clubsById.get(t.club_id) ?? t.club_id;
      const url = t.ics_url!;
      const res = await fetch(`/api/bfv/ics?url=${encodeURIComponent(url)}`, { cache: "no-store" });
      if (!res.ok) return [] as GameRow[];

      const icsText = await res.text().catch(() => "");
      let parsed = parseIcs(icsText);
      parsed = addHomeInfo(parsed, clubName, t.name);

      const filteredHome = homeOnly ? parsed.filter((g) => g.isHome !== false) : parsed;
      const dayGames = filteredHome.filter((g) => toYMDLocal(g.start) === dayStr);

      return dayGames.map((g) => {
        const r = resolveAgeU(t);
        return {
          ...g,
          bfvTeamId: t.id,
          bfvTeamName: t.name,
          bfvClubId: t.club_id,
          bfvClubName: clubName,
          bfvAgeU: r.ageU,
          bfvAgeSource: r.source,
          icsUrl: url,
        };
      });
    });

    const rows = results.flat();

    // Defaults: gebucht -> gebuchter Platz, sonst erster freier
    const defaults: Record<string, string> = {};
    for (const g of rows) {
      const bookedPitch = bookedPitchMap[g.uid];
      if (bookedPitch) {
        defaults[g.uid] = bookedPitch;
      } else {
        const avail = getAvailablePitches(g);
        if (avail[0]) defaults[g.uid] = avail[0].id;
      }
    }
    setSelectedPitchByUid(defaults);

    rows.sort((a, b) => {
      const t = a.start.getTime() - b.start.getTime();
      if (t !== 0) return t;
      const c = a.bfvClubName.localeCompare(b.bfvClubName);
      if (c !== 0) return c;
      return a.bfvTeamName.localeCompare(b.bfvTeamName);
    });

    setGames(rows);
  }

  // ---------- Main load ----------
  async function loadGames() {
    setLoadingGames(true);
    setError(null);

    try {
      if (isDayPlanning) {
        await loadGamesDay(dayPlanDate);
      } else {
        if (!selectedBfvTeam?.id || !selectedClub?.id) return;
        await loadGamesSingle(selectedBfvTeam, selectedClub.name);
      }
    } catch (e: any) {
      console.error(e);
      setGames([]);
      setError(e?.message || "Fehler beim Laden der Spiele.");
    } finally {
      setLoadingGames(false);
    }
  }

  // Auto-reload on selection changes
  useEffect(() => {
    if (!sessionChecked) return;
    if (!enableBFV) return;
    if (!isAdmin) return;

    // Tagesplanung aktiv
    if (isDayPlanning) {
      if (!dayPlanDate) return;
      loadGames();
      return;
    }

    // Einzelplanung
    if (!selectedBfvTeam?.id) return;
    loadGames();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionChecked, enableBFV, isAdmin, selectedBfvTeam?.id, homeOnly, isDayPlanning, dayPlanDate]);

  // ---------- Book / Undo ----------
  async function bookApproved(game: GameRow, pitchSelection: string) {
    setBusyUid(game.uid);
    setError(null);

    try {
      if (!pitchSelection || pitchSelection === SEP_VALUE) {
        throw new Error("Bitte zuerst einen Platz auswählen.");
      }

      const { pitchId, forceOverlap } = parsePitchSelection(pitchSelection);
      if (!pitchId) throw new Error("Bitte zuerst einen Platz auswählen.");

      if (forceOverlap) {
        const pitchName = pitches.find((p) => p.id === pitchId)?.name || "(unbekannter Platz)";
        const ok = window.confirm(
          `${pitchName} ist aktuell nicht frei.\n\nTrotzdem buchen (Überlappungen zulassen)?\n\nHinweis: Dieser Slot wird dann gelb markiert.`
        );
        if (!ok) return;
      }

      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user?.id;
      if (!uid) throw new Error("Session fehlt – bitte neu einloggen.");

      const localTeamId = resolveLocalTeamIdFor({ age_u: game.bfvAgeU, name: game.bfvTeamName });
      if (!localTeamId) {
        throw new Error(
          `Konnte keine passende lokale Mannschaft (teams) finden (für ${game.bfvTeamName}). Bitte Jahrgang/Name in 'teams' prüfen.`
        );
      }

      const noteBase = `[BFV] ${game.bfvClubName} – ${game.bfvTeamName}\n${game.summary}\n[BFV_TEAM_ID:${game.bfvTeamId}]\n[BFV_UID:${game.uid}]`;
      const note = forceOverlap ? `${noteBase}\n[FORCE_OVERLAP:true]` : noteBase;

      const insertRow: any = {
        start_at: game.start.toISOString(),
        end_at: game.end.toISOString(),
        status: "APPROVED",
        note,
        pitch_id: pitchId,
        team_id: localTeamId,
        created_by: uid,
      };
      // Optional: erlaubt bewusstes Buchen trotz Überlappung (DB-Änderung erforderlich: force_overlap boolean)
      if (forceOverlap) insertRow.force_overlap = true;

      const { data: ins, error: insErr } = await supabase
        .from("bookings")
        .insert(insertRow)
        .select("id,pitch_id")
        .maybeSingle();

      if (insErr) throw insErr;

      if (ins?.id) {
        setBookedMap((m) => ({ ...m, [game.uid]: ins.id }));
        setBookedPitchMap((m) => ({ ...m, [game.uid]: pitchId }));
        setBookedForcedMap((m) => ({ ...m, [game.uid]: forceOverlap }));
        // Auswahl zurücksetzen (verhindert "Stale"/Doppelklick-Effekte)
        setSelectedPitchByUid((m) => ({ ...m, [game.uid]: "" }));
      }

      // 1) Automatisch dasselbe wie "Aktualisieren" ausführen (damit Verfügbarkeiten sauber neu berechnet werden)
      await loadGames();
    } catch (e: any) {
      console.error(e);
      const msg = e?.message || "Fehler beim Buchen.";
      setError(msg);

      // Falls Overlap-Constraint zuschlägt, sofort neu laden (damit UI nicht mit alten Daten weiterarbeitet)
      if (String(e?.code) === "23P01" || String(msg).includes("bookings_no_overlap")) {
        try {
          await loadGames();
        } catch {
          // ignore
        }
      }
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

      if (range) await loadBookingsForRange(range.start, range.end);

      setBookedMap((m) => {
        const copy = { ...m };
        delete copy[gameUid];
        return copy;
      });
      setBookedPitchMap((m) => {
        const copy = { ...m };
        delete copy[gameUid];
        return copy;
      });
      setBookedForcedMap((m) => {
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

  // Anzeige-Infos
  const singleIcsUrl = selectedBfvTeam?.ics_url ?? null;

  return (
    <div style={{ maxWidth: 1200, margin: "24px auto", padding: 16 }}>
      <div
        className="card"
        style={{ padding: 16, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 900 }}>Ligaspiele planen (BFV)</div>
          <div style={{ opacity: 0.85, marginTop: 4 }}>
            {isDayPlanning ? `Tagesplanung: ${dayPlanDate}` : "Einzelplanung"}
          </div>
        </div>
        <Link
          href="/calendar"
          style={{ padding: "8px 12px", borderRadius: 12, border: "1px solid #273243", textDecoration: "none" }}
        >
          ← Kalender
        </Link>
      </div>

      <div className="card" style={{ marginTop: 12, padding: 16 }}>
        {error && <div style={{ color: "crimson", marginBottom: 10, fontWeight: 600 }}>{error}</div>}

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "end" }}>
          {/* Verein */}
          <div style={{ minWidth: 320 }}>
            <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 6 }}>Verein:</div>
            <select
              value={isDayPlanning ? "" : selectedClubId}
              onChange={(e) => setSelectedClubId(e.target.value)}
              style={{ width: "100%" }}
              disabled={isDayPlanning}
            >
              <option value="">{isDayPlanning ? "—" : "Bitte wählen"}</option>
              {clubs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Mannschaft */}
          <div style={{ minWidth: 360 }}>
            <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 6 }}>Mannschaft:</div>
            <select
              value={isDayPlanning ? "" : selectedBfvTeamId}
              onChange={(e) => setSelectedBfvTeamId(e.target.value)}
              style={{ width: "100%" }}
              disabled={isDayPlanning}
            >
              <option value="">{isDayPlanning ? "—" : "Bitte wählen"}</option>
              {teamsForClub.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {toULabel(t.age_u) ? ` (U${toULabel(t.age_u)})` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* ✅ Tagesplanung */}
          <div style={{ minWidth: 220 }}>
            <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 6 }}>Tagesplanung:</div>
            <input
              type="date"
              value={dayPlanDate}
              onChange={(e) => setDayPlanDate(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          <label style={{ display: "flex", gap: 10, alignItems: "center", paddingBottom: 6 }}>
            <input type="checkbox" checked={homeOnly} onChange={(e) => setHomeOnly(e.target.checked)} />
            nur Feldbergstraße
          </label>

          <button
            onClick={loadGames}
            disabled={isBusy || (isDayPlanning ? !dayPlanDate : !selectedBfvTeamId)}
            style={{ padding: "10px 14px", borderRadius: 12 }}
          >
            {loadingGames ? "Lade…" : "Aktualisieren"}
          </button>

          <div style={{ flex: 1, minWidth: 260, opacity: 0.8, fontSize: 13 }}>
            {isDayPlanning ? (
              <>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Hinweis:</div>
                <div>Es werden alle Mannschaften mit gepflegtem ICS-Link geprüft.
                <div style={{ marginTop: 4, opacity: 0.7 }}>Alterslogik: Anzeige-U = age_u + 1 (Quelle: Tabelle <code>teams</code>).</div></div>
              </>
            ) : singleIcsUrl ? (
              <>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>ICS:</div>
                <div style={{ wordBreak: "break-all" }}>{singleIcsUrl}</div>
              </>
            ) : (
              <div style={{ color: "crimson", fontWeight: 700 }}>Für diese Mannschaft ist kein ICS-Link hinterlegt.</div>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12, padding: 16 }}>
        {/*
          UI-Note:
          - Die Tabelle soll ohne horizontales Scrollen auskommen.
          - Daher geben wir den kleinen Spalten feste (schmale) Breiten und lassen "Spiel" flexibel.
          - Keine erzwungenen Mindestbreiten in Controls.
        */}
        <div style={{ overflowX: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: 10, borderBottom: "1px solid #273243", width: 110, whiteSpace: "nowrap" }}>
                  Datum
                </th>
                {isDayPlanning && (
                  <>
                    <th style={{ padding: 10, borderBottom: "1px solid #273243" }}>Verein</th>
                    <th style={{ padding: 10, borderBottom: "1px solid #273243" }}>Mannschaft</th>
                  </>
                )}
                <th style={{ padding: 10, borderBottom: "1px solid #273243" }}>Spiel</th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243", width: 70, whiteSpace: "nowrap" }}>
                  Heim?
                </th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243", width: 70, whiteSpace: "nowrap" }}>
                  Von
                </th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243", width: 70, whiteSpace: "nowrap" }}>
                  Bis
                </th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243", width: 230 }}>Freie Plätze</th>
                <th style={{ padding: 10, borderBottom: "1px solid #273243", width: 200, textAlign: "left" }}>
                  Aktion
                </th>
              </tr>
            </thead>
            <tbody>
              {games.map((g) => {
                const isBooked = !!bookedMap[g.uid];
                const busy = busyUid === g.uid;

                const candidates = allowedPitchesForAge(g.bfvAgeU);
                const avail = getAvailablePitches(g);
                const availIds = new Set(avail.map((p) => p.id));
                const blocked = candidates.filter((p) => !availIds.has(p.id));

                const selectedPitch = selectedPitchByUid[g.uid] || "";
                const forcedSelected = selectionIsForced(selectedPitch);
                const forcedBooked = !!bookedForcedMap[g.uid];

                const bookedPitchId = bookedPitchMap[g.uid] || "";
                const bookedPitchName = bookedPitchId ? (pitchesById.get(bookedPitchId)?.name ?? bookedPitchId) : "";

                return (
                  <tr key={`${g.bfvTeamId}:${g.uid}`}>
                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)", width: 110, whiteSpace: "nowrap" }}>
                      {fmtDateDE(g.start)}
                    </td>

                    {isDayPlanning && (
                      <>
                        <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                          {g.bfvClubName}
                        </td>
                        <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                          {g.bfvTeamName}
                          {toULabel(g.bfvAgeU) ? ` (U${toULabel(g.bfvAgeU)})` : ""}
                        </td>
                      </>
                    )}

                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>{g.summary}</td>

                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)", width: 70, whiteSpace: "nowrap" }}>
                      {g.isHome === true ? "Ja" : g.isHome === false ? "Nein" : "?"}
                    </td>

                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)", width: 70, whiteSpace: "nowrap" }}>
                      {fmtTimeDE(g.start)}
                    </td>

                    <td style={{ padding: 10, borderBottom: "1px solid rgba(255,255,255,0.08)", width: 70, whiteSpace: "nowrap" }}>
                      {fmtTimeDE(g.end)}
                    </td>

                    <td
                      style={{
                        padding: 10,
                        borderBottom: "1px solid rgba(255,255,255,0.08)",
                        width: 230,
                        background: forcedSelected
                          ? "rgba(250, 204, 21, 0.08)"
                          : "transparent",
                        borderRadius: 12,
                        minWidth: 0,
                      }}
                    >
                      {isBooked ? (
                        <div
                          style={{
                            width: "100%",
                            maxWidth: 230,
                            minWidth: 0,
                            padding: "6px 10px",
                            borderRadius: 10,
                            border: forcedBooked
                              ? "1px solid rgba(250, 204, 21, 0.55)"
                              : "1px solid rgba(255,255,255,0.18)",
                            background: forcedBooked
                              ? "rgba(250, 204, 21, 0.22)"
                              : "rgba(40, 160, 80, 0.20)",
                            fontWeight: 800,
                            height: "auto",
                            minHeight: 34,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            lineHeight: 1.15,
                            whiteSpace: "normal",
                            wordBreak: "break-word",
                          }}
                        >
                          {bookedPitchName || "Gebucht"}
                        </div>
                      ) : candidates.length === 0 ? (
                        <span style={{ color: "crimson", fontWeight: 700 }}>keine</span>
                      ) : (
                        <select
                          value={selectedPitch}
                          disabled={isBusy}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === SEP_VALUE) return;
                            setSelectedPitchByUid((m) => ({ ...m, [g.uid]: v }));
                          }}
                          style={{
                            width: "100%",
                            maxWidth: 230,
                            minWidth: 0,
                            padding: "6px 8px",
                            borderRadius: 10,
                            fontSize: 13,
                            border: forcedSelected
                              ? "1px solid rgba(250, 204, 21, 0.55)"
                              : "1px solid rgba(255,255,255,0.18)",
                            background: forcedSelected
                              ? "rgba(250, 204, 21, 0.18)"
                              : "rgba(255,255,255,0.06)",
                            color: "white",
                            colorScheme: "dark",
                            outline: "none",
                            cursor: isBusy ? "not-allowed" : "pointer",
                          }}
                        >
                          <option value="" style={{ backgroundColor: "#0b1220", color: "rgba(255,255,255,0.8)" }}>
                            Platz wählen…
                          </option>

                          {avail.map((p) => (
                            <option
                              key={p.id}
                              value={p.id}
                              style={{ backgroundColor: "#0b1220", color: "#e5e7eb" }}
                            >
                              {p.name}
                            </option>
                          ))}

                          {blocked.length > 0 && (
                            <>
                              <option
                                disabled
                                value={SEP_VALUE}
                                style={{
                                  backgroundColor: "#0b1220",
                                  color: "rgba(255,255,255,0.55)",
                                }}
                              >
                                ──────── nicht frei ────────
                              </option>
                              {blocked.map((p) => (
                                <option
                                  key={`force-${p.id}`}
                                  value={`${FORCE_PREFIX}${p.id}`}
                                  style={{
                                    backgroundColor: "rgba(250, 204, 21, 0.18)",
                                    color: "#111827",
                                  }}
                                >
                                  {p.name} (nicht frei, trotzdem buchen)
                                </option>
                              ))}
                            </>
                          )}
                        </select>
                      )}
                    </td>

                    <td
                      style={{
                        padding: 10,
                        borderBottom: "1px solid rgba(255,255,255,0.08)",
                        textAlign: "left",
                        verticalAlign: "middle",
                        width: 200,
                        minWidth: 0,
                      }}
                    >
                      {isBooked ? (
                        <button
                          disabled={isBusy || busy}
                          onClick={() => undoBooking(g.uid)}
                          style={{
                            width: "auto",
                            maxWidth: 220,
                            minWidth: 170,
                            padding: "6px 10px",
                            borderRadius: 10,
                            fontWeight: 800,
                            fontSize: 13,
                            height: "auto",
                            minHeight: 34,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: isBusy || busy ? "not-allowed" : "pointer",
                            border: "1px solid rgba(255,255,255,0.22)",
background: "rgba(40, 160, 80, 0.25)",
                            color: "rgba(220,255,235,0.95)",
                            whiteSpace: "normal",
                            lineHeight: 1.15,
                            opacity: isBusy || busy ? 0.6 : 1,
                          }}
                        >
                          Zurücknehmen
                        </button>
                      ) : (
                        <button
                          disabled={isBusy || busy || candidates.length === 0 || !selectedPitch}
                          onClick={() => bookApproved(g, selectedPitch)}
                          style={{
                            width: "auto",
                            maxWidth: 220,
                            minWidth: 170,
                            padding: "6px 10px",
                            borderRadius: 10,
                            fontWeight: 800,
                            fontSize: 13,
                            height: "auto",
                            minHeight: 34,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor:
                              isBusy || busy || candidates.length === 0 || !selectedPitch
                                ? "not-allowed"
                                : "pointer",
                            border: "1px solid rgba(255,255,255,0.18)",
                            background: "rgba(255,255,255,0.08)",
                            color: "white",
                            whiteSpace: "normal",
                            lineHeight: 1.15,
                            opacity:
                              isBusy || busy || candidates.length === 0 || !selectedPitch
                                ? 0.5
                                : 1,
                          }}
                        >
                          Buchen
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}

              {games.length === 0 && (
                <tr>
                  <td colSpan={isDayPlanning ? 9 : 7} style={{ padding: 14, opacity: 0.8 }}>
                    Keine Spiele gefunden.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 10, opacity: 0.75, fontSize: 13 }}>
          <div>
            Hinweis: Wenn ein Spiel kollidiert, kommt ggf. ein Overlap-Fehler. In der UI gilt:
            <b> U12 oder jünger</b> = bis zu <b>2</b> parallele Buchungen (nur mit U12/≤), <b>U13+</b> = exklusiv (und nur
            Großfeld). <span style={{ opacity: 0.9 }}>Altersquelle: <b>{AGE_SOURCE}</b>{missingAgeCount ? ` (fehlend bei ${missingAgeCount} BFV-Mannschaften)` : ""}</span>.
          </div>
          <div style={{ marginTop: 6 }}>
            In der UI blocken nur REQUESTED/APPROVED – wenn deine DB-Exclusion-Constraint aber noch REJECTED/CANCELLED blockt,
            musst du die Constraint in Supabase entsprechend anpassen.
          </div>
        </div>
      </div>
    </div>
  );
}