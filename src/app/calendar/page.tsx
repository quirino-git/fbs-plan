"use client";

import "./calendar.css";


// All selectable statuses for the status filter UI
const ALL_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"] as const;

import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import Link from "next/link";

import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import { DateSelectArg } from "@fullcalendar/core";
import deLocale from "@fullcalendar/core/locales/de";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  full_name: string | null;
  role: string | null;
  active: boolean | null;
};

type Pitch = { id: string; name: string; type: "GROSSFELD" | "KOMPAKT" };
type Team = { id: string; name: string; age_u: number };

type BookingStatus = "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";

type PitchRef = { id: string; name: string; type: "GROSSFELD" | "KOMPAKT" };
type TeamRef = { id: string; name: string };

type Booking = {
  id: string;
  start_at: string;
  end_at: string;
  status: BookingStatus;
  note: string | null;
  pitch_id: string;
  team_id: string;
  // embedded via select: pitches:pitch_id (...), teams:team_id (...)
  pitches: PitchRef | null;
  teams: TeamRef | null;
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function shortenPitchNameForList(name: string) {
  return String(name || "")
    .replace(/Grossfeld/gi, "GF")
    .replace(/Kompaktfeld/gi, "KF")
    .replace(/Kunstrasen/gi, "Kunstrasen")
    .replace(/Remiseplatz/gi, "Remise")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(text: string, maxLen = 34) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1).trimEnd() + "…" : s;
}

function cleanIcsLikeText(raw: string) {
  return String(raw || "")
    .replace(/\[BFV\]\s*/gi, "")
    .replace(/\[(?:BFV_[^\]]+|BFVTEAM_ID:[^\]]+|BFV_UID:[^\]]+)\]/gi, "")
    .replace(/\bBFV_UID:[^\s,\]]+/gi, "")
    .replace(/\bBFVTEAM_ID:[^\s,\]]+/gi, "")
    .replace(/\r?\n[ \t]+/g, "")
    .replace(/\\n/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\\,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTeamForCompare(raw: string) {
  return String(raw || "")
    .toLowerCase()
    .replace(/\(sg\)/gi, "")
    .replace(/\bsg\b/gi, "")
    .replace(/münchen/gi, "")
    .replace(/munchen/gi, "")
    .replace(/[^a-z0-9äöüß]+/gi, "");
}

function detectMatchType(raw: string) {
  const compact = cleanIcsLikeText(raw)
    .toLowerCase()
    .replace(/\s+/g, "");

  if (compact.includes("freundschaftsspiele")) return "Freundschaftsspiele";
  if (compact.includes("kinderfestival")) return "Kinderfestival";
  if (compact.includes("meisterschaften") || compact.includes("meisterschaft")) return "Meisterschaften";
  if (compact.includes("pokale") || compact.includes("pokal")) return "Pokale";
  return "";
}

function extractCompetitionFromIcs(raw: string) {
  const cleaned = cleanIcsLikeText(raw);
  if (!cleaned) return "";

  const parts = cleaned
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (parts.length >= 3) {
    return parts.slice(2).join(", ").trim();
  }
  return "";
}

function extractOpponentForHomeGame(firstSegment: string, localHome: string) {
  const segment = String(firstSegment || "").trim();
  const home = String(localHome || "").trim();
  if (!segment || !home) return "";

  const targetNorm = normalizeTeamForCompare(home);

  let matchEnd = -1;
  for (let i = 1; i <= segment.length; i++) {
    const prefix = segment.slice(0, i);
    if (normalizeTeamForCompare(prefix) === targetNorm) {
      matchEnd = i;
    }
  }

  if (matchEnd >= 0) {
    const rest = segment.slice(matchEnd).replace(/^[\s\-–:]+/, "").trim();
    if (rest) return rest;
  }

  const split = segment.split(/\s*[–-]\s*/).map((x) => x.trim()).filter(Boolean);
  if (split.length >= 2) {
    return split.slice(1).join(" – ").trim();
  }

  return "";
}

function buildHomeListLabelFromIcs(b: any, teamById: Map<string, Team>) {
  const localHome = String(b?.teams?.name || teamById.get(b?.team_id)?.name || "").trim();
  if (!localHome) return null;

  const raw = cleanIcsLikeText(String(b?.note || (b as any)?.tooltipText || (b as any)?.title || ""));
  if (!raw) return null;

  const firstSegment = raw.split(",")[0]?.trim() || "";
  if (!firstSegment) return null;

  const matchType = detectMatchType(raw);
  const competition = extractCompetitionFromIcs(raw);

  return {
    main: firstSegment,
    type: matchType,
    competition,
  };
}

function bookingLabelLikeDashboard(b: any) {
  const cleanup = (raw: string) =>
    String(raw || "")
      .replace(/\\,/g, ",")
      .replace(/\[(?:BFV_[^\]]+|BFVTEAM_ID:[^\]]+|BFV_UID:[^\]]+)\]/gi, "")
      .replace(/\bBFV_UID:[^\s,\]]+/gi, "")
      .replace(/\bBFVTEAM_ID:[^\s,\]]+/gi, "")
      .replace(/\\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const normalizeLabel = (raw: string) => {
    let label = cleanup(raw);
    if (!label.includes(" – ")) label = label.replace(/\s-\s/, " – ");
    return label;
  };

  const isTimeLine = (s: string) => /^\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}$/.test(s.trim());
  const isStatusLine = (s: string) => /^(REQUESTED|APPROVED|REJECTED|CANCELLED)$/i.test(s.trim());

  const pickBestTooltipLine = (tt: string) => {
    const parts = String(tt || "")
      .split(/\r?\n/)
      .map((x: string) => normalizeLabel(x))
      .filter((s: string) => !!s);

    if (!parts.length) return "";

    const filtered = parts.filter((s: string) => !isTimeLine(s) && !isStatusLine(s));
    const candidates = filtered.length ? filtered : parts;

    // In unserem tooltipText ist oft: [Platzname, Spielbezeichnung, Uhrzeit, Status]
    // => die längste sinnvolle Zeile ist fast immer die Spielbezeichnung.
    const best = [...candidates].sort((a: string, b: string) => b.length - a.length)[0];
    return best || "";
  };

  // 1) note (BFV-Spieltext) ist meist am besten
  const note = typeof b?.note === "string" ? b.note.trim() : "";
  if (note) {
    const parts = note.split(/\r?\n/).map((x: string) => normalizeLabel(x)).filter((s: string) => !!s);
    const best = [...parts].sort((a: string, b: string) => b.length - a.length)[0] || "";
    if (best) return best;
  }

  // 2) tooltipText (enthält oft Platz + Spiel + Zeit + Status)
  const tt = typeof (b as any)?.tooltipText === "string" ? String((b as any).tooltipText).trim() : "";
  if (tt) {
    const best = pickBestTooltipLine(tt);
    if (best) return best;
  }

  // 3) title (falls vorhanden)
  const title = typeof (b as any)?.title === "string" ? String((b as any).title).trim() : "";
  if (title) {
    const label = normalizeLabel(title);
    if (label) return label;
  }

  // 4) Fallback: Teamname
  const tn = typeof b?.teams?.name === "string" ? b.teams.name.trim() : "";
  return tn || "—";
}


function roundToStep(date: Date, stepMinutes: number) {
  const d = new Date(date);
  const ms = stepMinutes * 60 * 1000;
  return new Date(Math.round(d.getTime() / ms) * ms);
}

function toLocalDateTimeInputValue(date: Date) {
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toLocalDateOnly(date: Date) {
  return toLocalDateTimeInputValue(date).slice(0, 10);
}


function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfWeekMonday(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - day);
  return d;
}

function defaultWeekendRange(base: Date = new Date()) {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=So, 6=Sa

  let saturday: Date;
  if (day === 6) {
    saturday = new Date(d); // heute ist Samstag
  } else if (day === 0) {
    saturday = addDays(d, -1); // heute ist Sonntag -> gestriger Samstag
  } else {
    saturday = addDays(d, 6 - day); // Mo-Fr -> kommender Samstag
  }

  const sunday = addDays(saturday, 1);
  return { from: saturday, to: sunday };
}

function formatRangeLabel(rangeStart: Date, rangeEnd: Date) {
  const sameMonth =
    rangeStart.getMonth() === rangeEnd.getMonth() &&
    rangeStart.getFullYear() === rangeEnd.getFullYear();

  if (sameMonth) {
    return `${rangeStart.getDate()}. – ${rangeEnd.getDate()}. ${rangeStart.toLocaleDateString("de-DE", {
      month: "long",
      year: "numeric",
    })}`;
  }

  return `${rangeStart.toLocaleDateString("de-DE", {
    day: "numeric",
    month: "short",
  })} – ${rangeEnd.toLocaleDateString("de-DE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

function bookingStatusColor(status: string) {
  switch (String(status || "").toUpperCase()) {
    case "APPROVED":
      return "#2ecc71";
    case "REQUESTED":
      return "#f5a623";
    case "REJECTED":
      return "#ff5d5d";
    case "CANCELLED":
      return "#8b949e";
    default:
      return "#58a6ff";
  }
}

function WeekAgendaView({
  rangeStart,
  rangeEnd,
  bookings,
  pitchById,
  teamById,
  onPrevRange,
  onNextRange,
  onPresetWeekend,
  onFromChange,
  onToChange,
}: {
  rangeStart: Date;
  rangeEnd: Date;
  bookings: Booking[];
  pitchById: Map<string, Pitch>;
  teamById: Map<string, Team>;
  onPrevRange: () => void;
  onNextRange: () => void;
  onPresetWeekend: () => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}) {
  const totalDays = Math.max(1, Math.floor((rangeEnd.getTime() - rangeStart.getTime()) / 86400000) + 1);
  const days = useMemo(() => Array.from({ length: totalDays }, (_, i) => addDays(rangeStart, i)), [rangeStart, totalDays]);
  const today = new Date();

  return (
    <div className="card" style={{ padding: 16 }}>
      <div
        className="no-print"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          justifyContent: "space-between",
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onPrevRange}
            style={{ padding: "10px 14px", borderRadius: 12, fontWeight: 800, cursor: "pointer" }}
            title="Vorherige Woche"
          >
            ←
          </button>
          <button
            type="button"
            onClick={onNextRange}
            style={{ padding: "10px 14px", borderRadius: 12, fontWeight: 800, cursor: "pointer" }}
            title="Nächste Woche"
          >
            →
          </button>
          <button
            type="button"
            onClick={onPresetWeekend}
            style={{ padding: "10px 14px", borderRadius: 12, fontWeight: 800, cursor: "pointer" }}
          >
            Heute
          </button>
        </div>

        <div style={{ fontSize: 18, fontWeight: 900, textAlign: "center", minWidth: 260 }}>
          {formatRangeLabel(rangeStart, rangeEnd)}
        </div>

        <div style={{ display: "flex", alignItems: "end", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <label style={{ fontSize: 13, color: "rgba(230,237,243,0.78)" }}>
            Von
            <input
              type="date"
              value={toLocalDateOnly(rangeStart)}
              onChange={(e) => onFromChange(e.target.value)}
              style={{
                marginLeft: 8,
                padding: "8px 10px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "transparent",
                color: "#e6edf3",
              }}
            />
          </label>
          <label style={{ fontSize: 13, color: "rgba(230,237,243,0.78)" }}>
            Bis
            <input
              type="date"
              value={toLocalDateOnly(rangeEnd)}
              onChange={(e) => onToChange(e.target.value)}
              style={{
                marginLeft: 8,
                padding: "8px 10px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "transparent",
                color: "#e6edf3",
              }}
            />
          </label>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {days.map((day) => {
          const dayStart = new Date(day);
          dayStart.setHours(0, 0, 0, 0);
          const dayEnd = addDays(dayStart, 1);

          const dayBookings = bookings
            .filter((b) => {
              const bs = new Date(b.start_at);
              const be = new Date(b.end_at);
              return bs < dayEnd && be > dayStart;
            })
            .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

          const isToday = sameDay(day, today);
          const isWeekend = day.getDay() === 0 || day.getDay() === 6;

          return (
            <div
              key={day.toISOString()}
              style={{
                display: "grid",
                gridTemplateColumns: "110px 1fr",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 18,
                overflow: "hidden",
                background: isToday
                  ? "rgba(88, 166, 255, 0.06)"
                  : isWeekend
                  ? "rgba(255,255,255,0.025)"
                  : "rgba(255,255,255,0.015)",
              }}
            >
              <div
                style={{
                  padding: "16px 12px",
                  borderRight: "1px solid rgba(255,255,255,0.07)",
                  background: "rgba(255,255,255,0.04)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div style={{ textAlign: "center", lineHeight: 1 }}>
                  <div
                    style={{
                      fontSize: 34,
                      fontWeight: 900,
                      color: isWeekend ? "#f0b6b6" : "#e6edf3",
                    }}
                  >
                    {day.getDate()}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 22,
                      fontWeight: 500,
                      color: isWeekend ? "#f0b6b6" : "rgba(230,237,243,0.92)",
                    }}
                  >
                    {day.toLocaleDateString("de-DE", { weekday: "short" }).replace(".", "")}
                  </div>
                </div>
              </div>

              <div style={{ padding: "14px 16px", minHeight: 102 }}>
                {dayBookings.length === 0 ? (
                  <div style={{ color: "rgba(230,237,243,0.45)", fontStyle: "italic", paddingTop: 4 }}>
                    Keine Termine
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {dayBookings.map((b) => {
                      const color = bookingStatusColor(b.status);
                      const pitchName = b.pitches?.name ?? pitchById.get(b.pitch_id)?.name ?? "Platz";
                      const teamName = bookingLabelLikeDashboard(b) || b.teams?.name || teamById.get(b.team_id)?.name || "Termin";

                      return (
                        <div
                          key={b.id}
                          title={`${fmtTime(b.start_at)}–${fmtTime(b.end_at)}\n${pitchName}\n${teamName}\n${b.status}`}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "6px 92px 1fr",
                            alignItems: "start",
                            gap: 10,
                            padding: "6px 4px",
                            borderRadius: 12,
                            background: "rgba(255,255,255,0.02)",
                          }}
                        >
                          <div
                            style={{
                              width: 4,
                              borderRadius: 999,
                              alignSelf: "stretch",
                              background: color,
                              minHeight: 24,
                              marginLeft: 1,
                            }}
                          />
                          <div
                            style={{
                              fontSize: 15,
                              fontWeight: 800,
                              whiteSpace: "nowrap",
                              color: "#dce6f3",
                            }}
                          >
                            {fmtTime(b.start_at)}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: 15,
                                fontWeight: 700,
                                color: "#e6edf3",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {teamName}
                            </div>
                            <div
                              style={{
                                marginTop: 2,
                                fontSize: 13,
                                color: "rgba(230,237,243,0.74)",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {pitchName} · {fmtTime(b.start_at)}–{fmtTime(b.end_at)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


export default function CalendarPage() {
  const [sessionChecked, setSessionChecked] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);

  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);

  const [pitchFilterIds, setPitchFilterIds] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<BookingStatus[]>(["REQUESTED", "APPROVED"]);

  const [pitchPickerOpen, setPitchPickerOpen] = useState(false);
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [initialView] = useState<"timeGridWeek" | "dayGridMonth">("timeGridWeek");
  const [initialDate] = useState<Date>(new Date());

  // Tooltip
  const [tip, setTip] = useState<{ show: boolean; x: number; y: number; text: string }>({
    show: false,
    x: 0,
    y: 0,
    text: "",
  });
  const lastMouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // -------------------------
  // View switcher (Woche/Monat/Liste)
  // -------------------------
  const calendarRef = useRef<FullCalendar | null>(null);
  const [viewMode, setViewMode] = useState<"week" | "month" | "list" | "dashboard" | "mobile">("week");
  const [weekRange, setWeekRange] = useState<{ from: Date; to: Date }>(() => defaultWeekendRange(new Date()));

  // List view range (von/bis, inkl. Tage)
  const [listFrom, setListFrom] = useState<string>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 1);
    return toYMDLocal(d);
  });
const [listTo, setListTo] = useState<string>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return toYMDLocal(d);
  });
  const [mobileDay, setMobileDay] = useState<string>(() => toYMDLocal(new Date()));
function hideTip() {
    setTip((t) => ({ ...t, show: false }));
  }

  function positionTip(x: number, y: number, text: string) {
    // simple clamp inside viewport
    const padding = 10;
    const maxW = 380;
    const approxW = Math.min(maxW, Math.max(220, text.length * 6));
    const approxH = 64;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let nx = x + 14;
    let ny = y + 14;

    if (nx + approxW + padding > vw) nx = vw - approxW - padding;
    if (ny + approxH + padding > vh) ny = vh - approxH - padding;

    setTip({ show: true, x: nx, y: ny, text });
  }

  // Mouse tracking for tooltip positioning
  useEffect(() => {
    function onMove(e: MouseEvent) {
      lastMouse.current = { x: e.clientX, y: e.clientY };
      if (tip.show) positionTip(e.clientX, e.clientY, tip.text);
    }
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [tip.show, tip.text]);

  useEffect(() => {
    if (viewMode !== "week") return;
    const start = new Date(weekRange.from);
    start.setHours(0, 0, 0, 0);
    const endInclusive = new Date(weekRange.to);
    endInclusive.setHours(0, 0, 0, 0);
    const endExclusive = addDays(endInclusive, 1);
    loadBookings(start, endExclusive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, weekRange.from, weekRange.to]);

  // Default List-Zeitraum: aktuelle Woche (Mo..So)
  useEffect(() => {
    if (listFrom || listTo) return;
    const now = new Date();
    const day = (now.getDay() + 6) % 7; // Mon=0
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - day);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);

    const toISO = (d: Date) => toYMDLocal(d);
    setListFrom(toISO(monday));
    setListTo(toISO(sunday));
  }, [listFrom, listTo]);

  // -------------------------
  // Session + Profil laden
  // -------------------------
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

  // -------------------------
  // Pitches + Teams laden
  // -------------------------
  useEffect(() => {
    if (!sessionChecked) return;

    (async () => {
      setError(null);

      const [pitchesRes, teamsRes] = await Promise.all([
        supabase.from("pitches").select("id,name,type").order("name"),
        supabase.from("teams").select("id,name,age_u").order("age_u").order("name"),
      ]);

      if (pitchesRes.error) return setError(pitchesRes.error.message);
      if (teamsRes.error) return setError(teamsRes.error.message);

      const p = (pitchesRes.data ?? []) as Pitch[];
      const t = (teamsRes.data ?? []) as Team[];

      setPitches(p);
      setTeams(t);

      // Default: alle Plätze aktiv
      setPitchFilterIds(p.map((x) => x.id));
    })();
  }, [sessionChecked]);

  const pitchById = useMemo(() => {
    const m = new Map<string, Pitch>();
    pitches.forEach((p) => m.set(p.id, p));
    return m;
  }, [pitches]);

  const teamById = useMemo(() => {
    const m = new Map<string, Team>();
    teams.forEach((t) => m.set(t.id, t));
    return m;
  }, [teams]);

  // -------------------------
  // Bookings laden
  // -------------------------
  async function loadBookings(start: Date, end: Date) {
    setError(null);

    const startISO = start.toISOString();
    const endISO = end.toISOString();

    const { data, error } = await supabase
      .from("bookings")
      .select(
        `
        id, start_at, end_at, status, note, pitch_id, team_id,
        pitches:pitch_id ( id, name, type ),
        teams:team_id ( id, name )
      `
      )
      .gte("start_at", startISO)
      .lt("start_at", endISO)
      .in("status", statusFilter)
      .order("start_at", { ascending: true });

    if (error) {
      console.error(error);
      setError(error.message);
      setBookings([]);
      return;
    }

    const rows = (data ?? []) as any[];

    const list: Booking[] = rows.map((r) => ({
      ...r,
      pitches: Array.isArray(r.pitches) ? (r.pitches[0] ?? null) : (r.pitches ?? null),
      teams: Array.isArray(r.teams) ? (r.teams[0] ?? null) : (r.teams ?? null),
    }));

    setBookings(list);
  }

  const filteredBookings = useMemo(() => {
    const allowed = new Set(pitchFilterIds);
    return bookings.filter((b) => allowed.has(b.pitch_id) && statusFilter.includes(b.status));
  }, [bookings, pitchFilterIds, statusFilter]);

  // -------------------------
  // FullCalendar events
  // -------------------------
  const events = useMemo(() => {
    return filteredBookings.map((b) => {
      const p = b.pitches?.name ?? pitchById.get(b.pitch_id)?.name ?? "Platz";
      const t = b.teams?.name ?? teamById.get(b.team_id)?.name ?? "Team";

      return {
        id: b.id,
        title: `${p} – ${t}`,
        start: b.start_at,
        end: b.end_at,
        extendedProps: {
          status: b.status,
          tooltipText: `${p}\n${t}\n${fmtTime(b.start_at)}–${fmtTime(b.end_at)}\n${b.status}`,
        },
      };
    });
  }, [filteredBookings, pitchById, teamById]);

  // -------------------------
  // LIST VIEW (Variante A: Zeitraster x Plätze)
  // -------------------------
  const LIST_START_HOUR = 8.5;
  const LIST_END_HOUR = 21;
  const SLOT_MIN = 15;


// Overlap-Layout: doppelte Buchungen nebeneinander darstellen (pro Platz / Tag)
type OverlapBox = { id: string; start: Date; end: Date };
type OverlapPos = { colIndex: number; colCount: number };

function boxesOverlap(a: OverlapBox, b: OverlapBox) {
  return a.start < b.end && a.end > b.start;
}

function computeOverlapLayout(boxes: OverlapBox[]): Map<string, OverlapPos> {
  // Greedy column assignment (ähnlich Kalender)
  const sorted = [...boxes].sort((a, b) => a.start.getTime() - b.start.getTime());
  const colsEnd: Date[] = []; // Endzeit pro Spalte
  const colIndexById = new Map<string, number>();

  for (const ev of sorted) {
    let col = 0;
    for (; col < colsEnd.length; col++) {
      if (ev.start >= colsEnd[col]) break; // Spalte frei
    }
    if (col === colsEnd.length) colsEnd.push(ev.end);
    else colsEnd[col] = ev.end;
    colIndexById.set(ev.id, col);
  }

  // Für jedes Event: maximale Spaltenanzahl seiner Overlap-Gruppe bestimmen
  const out = new Map<string, OverlapPos>();
  for (const a of sorted) {
    let maxCol = colIndexById.get(a.id) ?? 0;
    for (const b of sorted) {
      if (a.id === b.id) continue;
      if (boxesOverlap(a, b)) {
        maxCol = Math.max(maxCol, colIndexById.get(b.id) ?? 0);
      }
    }
    out.set(a.id, { colIndex: colIndexById.get(a.id) ?? 0, colCount: maxCol + 1 });
  }
  return out;
}

  function parseDateInput(value: string) {
    if (!value) return null; // YYYY-MM-DD
    const [y, m, d] = value.split("-").map((x) => parseInt(x, 10));
    if (!y || !m || !d) return null;
    const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function addDays(d: Date, days: number) {
    const out = new Date(d);
    out.setDate(out.getDate() + days);
    return out;
  }

  function startOfDay(d: Date) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    return out;
  }

  function toYMDLocal(d: Date) {
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  function clamp(date: Date, min: Date, max: Date) {
    return new Date(Math.max(min.getTime(), Math.min(max.getTime(), date.getTime())));
  }

  function minutesSinceStart(d: Date) {
    return d.getHours() * 60 + d.getMinutes() - LIST_START_HOUR * 60;
  }

  function slotIndex(d: Date) {
    return Math.floor(minutesSinceStart(d) / SLOT_MIN);
  }

  function buildSlots() {
    const slots: { label: string; minutes: number }[] = [];
    const startMin = LIST_START_HOUR * 60;
    const endMin = LIST_END_HOUR * 60;
    for (let m = startMin; m < endMin; m += SLOT_MIN) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      const showLabel = m % 30 === 0;
      slots.push({ label: showLabel ? `${hh}:${mm}` : "", minutes: m });
    }
    return slots;
  }

  const listSlots = useMemo(() => buildSlots(), []);

  const visiblePitchesForList = useMemo(() => {
    const allowed = new Set(pitchFilterIds);
    return pitches.filter((p) => allowed.has(p.id));
  }, [pitches, pitchFilterIds]);

  const listDays = useMemo(() => {
    const from = parseDateInput(listFrom);
    const to = parseDateInput(listTo);
    if (!from || !to) return [] as Date[];
    const a = startOfDay(from);
    const b = startOfDay(to);
    const start = a <= b ? a : b;
    const end = a <= b ? b : a;

    const days: Date[] = [];
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) days.push(new Date(d));
    return days;
  }, [listFrom, listTo]);

  async function loadListRange() {
    const from = parseDateInput(listFrom);
    const to = parseDateInput(listTo);
    if (!from || !to) {
      setError("Bitte Zeitraum (von/bis) wählen.");
      return;
    }

    const a = startOfDay(from);
    const b = startOfDay(to);
    const start = a <= b ? a : b;
    const endInclusive = a <= b ? b : a;
    const endExclusive = addDays(endInclusive, 1);
    await loadBookings(start, endExclusive);
  }

  async function loadSingleDay(dayIso: string) {
    const day = parseDateInput(dayIso);
    if (!day) {
      setError("Bitte ein gültiges Datum wählen.");
      return;
    }
    const start = startOfDay(day);
    const endExclusive = addDays(start, 1);
    setListFrom(dayIso);
    setListTo(dayIso);
    setMobileDay(dayIso);
    await loadBookings(start, endExclusive);
  }

  // -------------------------
  // Navigation to request page
  // -------------------------
  function goToRequestNew(start: Date, end: Date, fromView: string, focusDate: Date, pitchId?: string) {
    const params = new URLSearchParams();
    params.set("start", toLocalDateTimeInputValue(start));
    params.set("end", toLocalDateTimeInputValue(end));
    params.set("returnView", fromView);
    params.set("returnDate", toLocalDateOnly(focusDate));
    // alte Parameter zusätzlich für Rückwärtskompatibilität
    params.set("from", fromView);
    params.set("focus", focusDate.toISOString());
    if (pitchId) params.set("pitchId", pitchId);
    window.location.assign(`/request/new?${params.toString()}`);
  }

  
// -------------------------
// Dashboard (Cards per pitch)
// -------------------------
// -------------------------
// Dashboard (Cards per pitch) + Drag & Drop
// -------------------------



function PitchDashboardView({
  pitches,
  bookings,
  from,
  to,
  darkMode,
  singleColumn = false,
}: {
  pitches: Pitch[];
  bookings: Booking[];
  from: string;
  to: string;
  darkMode: boolean;
  singleColumn?: boolean;
}) {
  const [orderByDay, setOrderByDay] = useState<Record<string, string[]>>({});
  const [dropHint, setDropHint] = useState<{ dayKey: string; insertIndex: number } | null>(null);
  const dayGridRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("fcstern_pitch_order_by_day");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const norm: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (Array.isArray(v)) norm[k] = v.map(String);
          }
          setOrderByDay(norm);
          return;
        }
      }
    } catch {}
    try {
      const legacy = window.localStorage.getItem("fcstern_pitch_order");
      if (legacy) {
        const arr = JSON.parse(legacy);
        if (Array.isArray(arr)) setOrderByDay({ __legacy__: arr.map(String) });
      }
    } catch {}
  }, []);

  const saveOrderByDay = (next: Record<string, string[]>) => {
    setOrderByDay(next);
    try {
      window.localStorage.setItem("fcstern_pitch_order_by_day", JSON.stringify(next));
    } catch {}
  };

  const dayLabel = (d: Date) =>
    d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const dayKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const fromDate = useMemo(() => new Date(`${from}T00:00:00`), [from]);
  const toDate = useMemo(() => new Date(`${to}T00:00:00`), [to]);

  const visibleDays = useMemo(() => {
    const days: { key: string; date: Date; label: string }[] = [];
    const cur = new Date(fromDate);
    const last = new Date(toDate);
    while (cur <= last) {
      const d = new Date(cur);
      days.push({ key: dayKey(d), date: d, label: dayLabel(d) });
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  }, [fromDate, toDate]);

  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const byPitchAndDay = useMemo(() => {
    const map = new Map<string, Map<string, Booking[]>>();
    for (const p of pitches) map.set(String(p.id), new Map());
    for (const b of bookings) {
      const pid = String(b.pitch_id);
      if (!map.has(pid)) map.set(pid, new Map());
      const s = new Date(b.start_at);
      const e = new Date(b.end_at);
      const cur = startOfDay(s);
      const last = startOfDay(e);
      while (cur <= last) {
        const k = dayKey(cur);
        const dayStart = startOfDay(cur);
        const dayEnd = endOfDay(cur);
        if (e > dayStart && s < dayEnd) {
          const dm = map.get(pid)!;
          const arr = dm.get(k) ?? [];
          arr.push(b);
          dm.set(k, arr);
        }
        cur.setDate(cur.getDate() + 1);
      }
    }
    for (const [, dm] of map) {
      for (const [k, arr] of dm) {
        arr.sort((a, b) => +new Date(a.start_at) - +new Date(b.start_at));
        dm.set(k, arr);
      }
    }
    return map;
  }, [bookings, pitches]);

  const getSortedPitchesForDay = (k: string) => {
    const order = orderByDay[k] ?? (visibleDays.length === 1 ? orderByDay["__legacy__"] : undefined) ?? [];
    if (!order.length) return pitches;
    const pos = new Map(order.map((id, i) => [String(id), i]));
    return [...pitches].sort((a, b) => {
      const pa = pos.has(String(a.id)) ? (pos.get(String(a.id)) as number) : Number.MAX_SAFE_INTEGER;
      const pb = pos.has(String(b.id)) ? (pos.get(String(b.id)) as number) : Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name, "de");
    });
  };

  
const reorderDayToIndex = (dayKeyValue: string, fromId: string, rawInsertIndex: number) => {
  const nextMap = { ...orderByDay };
  const base = (nextMap[dayKeyValue]?.length ? [...nextMap[dayKeyValue]] : pitches.map((x) => String(x.id))).map(String);
  const fromIdx = base.findIndex((id) => id === String(fromId));
  if (fromIdx < 0) return;
  const [moved] = base.splice(fromIdx, 1);

  let insertIndex = Math.max(0, Math.min(rawInsertIndex, base.length));
  if (fromIdx < rawInsertIndex) insertIndex -= 1;
  insertIndex = Math.max(0, Math.min(insertIndex, base.length));

  base.splice(insertIndex, 0, String(moved));
  nextMap[dayKeyValue] = base;
  saveOrderByDay(nextMap);
};

const getGridCardsOrdered = (dayKeyValue: string) => {
  const gridEl = dayGridRefs.current[dayKeyValue];
  if (!gridEl) return [] as { id: string; rect: DOMRect }[];
  const cards = Array.from(gridEl.querySelectorAll('[data-pitch-card="1"]')) as HTMLDivElement[];
  return cards
    .map((el) => ({ id: String(el.dataset.pitchId || ""), rect: el.getBoundingClientRect() }))
    .filter((x) => !!x.id)
    .sort((a, b) => {
      const dy = a.rect.top - b.rect.top;
      if (Math.abs(dy) > 16) return dy;
      return a.rect.left - b.rect.left;
    });
};

const computeInsertIndexFromPointer = (dayKeyValue: string, clientX: number, clientY: number) => {
  const ordered = getGridCardsOrdered(dayKeyValue);
  if (!ordered.length) return 0;

  // Build visual rows from actual rendered card positions (responsive-safe)
  const rows: { top: number; bottom: number; centerY: number; items: typeof ordered }[] = [];
  for (const item of ordered) {
    const r = item.rect;
    const centerY = r.top + r.height / 2;
    const row = rows.find((rw) => Math.abs(rw.centerY - centerY) < 28);
    if (!row) {
      rows.push({ top: r.top, bottom: r.bottom, centerY, items: [item] as any });
    } else {
      row.items.push(item as any);
      row.top = Math.min(row.top, r.top);
      row.bottom = Math.max(row.bottom, r.bottom);
      row.centerY = row.items.reduce((acc, it) => acc + (it.rect.top + it.rect.height / 2), 0) / row.items.length;
    }
  }

  rows.sort((a, b) => a.top - b.top);
  rows.forEach((row) => row.items.sort((a, b) => a.rect.left - b.rect.left));

  // Pointer above first / below last row
  if (clientY < rows[0].top) return 0;
  if (clientY > rows[rows.length - 1].bottom) return ordered.length;

  // Find target row (closest by Y)
  let rowIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const d = Math.min(Math.abs(clientY - row.centerY), clientY < row.top ? row.top - clientY : clientY > row.bottom ? clientY - row.bottom : 0);
    if (d < bestDist) {
      bestDist = d;
      rowIdx = i;
    }
  }

  const row = rows[rowIdx];
  // insertion before first if left of first center
  for (let i = 0; i < row.items.length; i++) {
    const item = row.items[i];
    const cx = item.rect.left + item.rect.width / 2;
    if (clientX < cx) {
      return ordered.findIndex((x) => x.id === item.id);
    }
  }
  // otherwise after last in row
  const last = row.items[row.items.length - 1];
  return ordered.findIndex((x) => x.id === last.id) + 1;
};

const gridCols = singleColumn ? "minmax(0, 1fr)" : "repeat(auto-fit, minmax(320px, 1fr))";


  return (
    <div style={{ display: "grid", gap: 12 }}>
      {visibleDays.map((day) => (
        <div key={day.key} className="print-day">
          <div className="day-header" style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, textTransform: "capitalize" }}>
            {day.label}
          </div>

          <div
            ref={(el) => { dayGridRefs.current[day.key] = el; }}
            className="print-grid"
            style={{ display: "grid", gridTemplateColumns: gridCols, gap: 10, alignItems: "start" }}
            onDragOver={(e) => {
              e.preventDefault();
              const dragDay = e.dataTransfer.getData("text/day-key");
              const fromId = e.dataTransfer.getData("text/plain");
              if (!fromId || (dragDay && dragDay !== day.key)) return;
              const insertIndex = computeInsertIndexFromPointer(day.key, e.clientX, e.clientY);
              setDropHint({ dayKey: day.key, insertIndex });
            }}
            onDrop={(e) => {
              e.preventDefault();
              const fromId = e.dataTransfer.getData("text/plain");
              const fromDay = e.dataTransfer.getData("text/day-key");
              if (!fromId || fromDay !== day.key) return;
              const insertIndex = computeInsertIndexFromPointer(day.key, e.clientX, e.clientY);
              reorderDayToIndex(day.key, fromId, insertIndex);
              setDropHint(null);
            }}
            onDragLeave={(e) => {
              const next = e.relatedTarget as Node | null;
              if (!next || !(e.currentTarget as HTMLDivElement).contains(next)) {
                setDropHint((prev) => (prev?.dayKey === day.key ? null : prev));
              }
            }}
          >
            {(() => { const sortedPitches = getSortedPitchesForDay(day.key); return sortedPitches.map((p, visualIdx) => {
              const cards = byPitchAndDay.get(String(p.id))?.get(day.key) ?? [];
              const showBeforeHint = dropHint?.dayKey === day.key && dropHint?.insertIndex === visualIdx;
              const showAfterHint = dropHint?.dayKey === day.key && dropHint?.insertIndex === sortedPitches.length && visualIdx === sortedPitches.length - 1;

              return (
                <div
                  key={`${day.key}-${p.id}`}
                  data-pitch-card="1"
                  data-day-key={day.key}
                  data-pitch-id={String(p.id)}
                  className="card"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", String(p.id));
                    e.dataTransfer.setData("text/day-key", day.key);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDropHint(null)}
                  style={{
                    position: "relative",
                    padding: 12,
                    cursor: "grab",
                    minHeight: 120,
                    border: "1px solid rgba(255,255,255,0.08)",
                    boxShadow: showBeforeHint || showAfterHint ? "0 0 0 2px rgba(90,200,255,0.14) inset" : undefined,
                  }}
                >
                  {(showBeforeHint || showAfterHint) && (
                    <div
                      style={{
                        position: "absolute",
                        left: 10,
                        right: 10,
                        height: 0,
                        borderTop: "3px solid rgba(90,200,255,0.9)",
                        top: showBeforeHint ? 8 : undefined,
                        bottom: showAfterHint ? 8 : undefined,
                        borderRadius: 999,
                        pointerEvents: "none",
                      }}
                    />
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontWeight: 650, fontSize: 14 }}>{p.name}</div>
                    <div style={{ opacity: 0.7, fontSize: 13 }}>
                      {cards.length} Buchung{cards.length === 1 ? "" : "en"}
                    </div>
                  </div>

                  {cards.length === 0 ? (
                    <div style={{ opacity: 0.7 }}>Keine Buchungen im Zeitraum.</div>
                  ) : (
                    <div style={{ display: "grid", gap: 12 }}>
                      {cards.map((b, idx) => (
                        <div
                          key={`${b.id}-${idx}`}
                          className="print-booking-card"
                          style={{
                            borderRadius: 14,
                            border: "1px solid rgba(0,255,170,0.25)",
                            background: "linear-gradient(180deg, rgba(0,255,170,0.10), rgba(0,255,170,0.06))",
                            padding: "10px 12px",
                            minHeight: 76, // grows automatically for long titles
                          }}
                        >
                          <div
                            className="print-booking-title"
                            style={{
                              fontWeight: 600,
                              fontSize: 14,
                              lineHeight: 1.25,
                              marginBottom: 4,
                              color: darkMode ? "rgba(255,255,255,0.95)" : "#0b1220",
                              whiteSpace: "normal",
                              overflow: "visible",
                              wordBreak: "break-word",
                            }}
                            title={bookingLabelLikeDashboard(b)}
                          >
                            {bookingLabelLikeDashboard(b)}
                          </div>
                          <div className="print-booking-time" style={{ opacity: 0.95, fontSize: 14, fontWeight: 600, letterSpacing: 0.2 }}>
                            {fmtTime(b.start_at)}–{fmtTime(b.end_at)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }); })()}
          </div>
        </div>
      ))}
    </div>
  );
}

const isAdmin = useMemo(() => (profile?.role || "TRAINER").toUpperCase() === "ADMIN", [profile]);

  if (!sessionChecked) return null;

  return (
    <div className="page-root" style={{ maxWidth: viewMode === "list" || viewMode === "dashboard" || viewMode === "mobile" ? "none" : 1200, width: "100%", margin: "24px auto", padding: 16 }}>
      <style jsx global>{`
        @media print {
          @page { size: A4 landscape; margin: 4mm; }

          html, body {
            background: #fff !important;
            color: #111 !important;
            margin: 0 !important;
            padding: 0 !important;
          }

          .no-print { display: none !important; }

          .page-root {
            margin: 0 !important;
            padding: 0 !important;
            max-width: none !important;
            width: 100% !important;
          }

          .list-print-root {
            padding: 0 !important;
            margin: 0 !important;
            background: #fff !important;
            border: none !important;
            box-shadow: none !important;
            min-height: 0 !important;
            overflow: visible !important;
          }

          .print-wrap {
            overflow: hidden !important;
            width: 100% !important;
            box-sizing: border-box !important;
          }

          .list-print-grid {
            width: calc(100% - 4mm) !important;
            max-width: calc(100% - 4mm) !important;
            min-width: 0 !important;
            margin: 0 auto !important;
            gap: 3px !important;
            --time-col-width: 46px !important;
            --header-row-height: 20px !important;
            --slot-row-height: 9px !important;
            grid-template-columns: var(--time-col-width) repeat(var(--pitch-count), minmax(0, 1fr)) !important;
            grid-template-rows: var(--header-row-height) repeat(var(--slot-count), var(--slot-row-height)) !important;
            box-sizing: border-box !important;
          }

          .print-pitch-header {
            font-size: 9px !important;
            padding: 2px 4px !important;
            border-radius: 6px !important;
          }

          .print-time-cell {
            font-size: 9px !important;
            padding: 1px 2px !important;
            border-radius: 6px !important;
          }

          .print-event {
            font-size: 8px !important;
            line-height: 1.0 !important;
            padding: 2px 3px !important;
            border-radius: 6px !important;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
            box-shadow: none !important;
          }

          .print-booking-card {
            background: #fff !important;
            border: 1px solid #cfd8dc !important;
          }
          .print-booking-title,
          .print-booking-time {
            color: #111 !important;
            opacity: 1 !important;
            text-shadow: none !important;
          }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

          .print-day {
            break-before: page;
            break-inside: avoid;
            page-break-before: always;
            page-break-inside: avoid;
            padding: 4mm 4mm 3mm 6mm !important;
            margin: 0 !important;
            min-height: 196mm !important;
            background: #fff !important;
            border: none !important;
            box-shadow: none !important;
            overflow: hidden !important;
            box-sizing: border-box !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: center !important;
          }
          .print-day.print-day-first {
            break-before: auto !important;
            page-break-before: auto !important;
          }
          .print-day .day-header {
            break-after: avoid;
            page-break-after: avoid;
            font-size: 12px !important;
            margin-bottom: 4px !important;
            padding-left: 6px !important;
          }
        }`}</style>

      {/* Header */}
      <div
        className="card no-print"
        style={{
          padding: 16,
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 900 }}>BSA Feldbergstr. Spiele-Belegungsplan</div>
          <div style={{ opacity: 0.85, marginTop: 4 }}>
            {profile?.full_name ?? "—"} • Rolle: {profile?.role ?? "—"} • {profile?.active ? "aktiv" : "inaktiv"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Link
            href="/request/new"
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              textDecoration: "none",
            }}
          >
            + Antrag
          </Link>

          {isAdmin && (
            <Link
              href="/approve"
              style={{
                padding: "8px 12px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.18)",
                textDecoration: "none",
              }}
            >
              Genehmigen
            </Link>
          )}

          <Link
            href="/bfv"
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              textDecoration: "none",
            }}
          >
            {isAdmin ? "Ligaspiele planen (BFV)" : "Ligaspiele ansehen (BFV)"}
          </Link>

          <button
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = "/login";
            }}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "transparent",
              color: "#e6edf3",
              cursor: "pointer",
            }}
          >
            Logout
          </button>
        </div>
      </div>

      
      {/* Zeitraum */}
{error && <div style={{ marginTop: 12, color: "crimson", fontWeight: 700 }}>{error}</div>}

      {/* Kalender */}
      <div style={{ marginTop: 16 }}>
        {/* View Switcher */}
        <div
          className="no-print"
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          <button
            onClick={() => {
              setViewMode("week");
              setWeekRange(defaultWeekendRange(new Date()));
            }}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: viewMode === "week" ? "rgba(255,255,255,0.10)" : "transparent",
              color: "#e6edf3",
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Woche
          </button>
          <button
            onClick={() => {
              setViewMode("month");
            }}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: viewMode === "month" ? "rgba(255,255,255,0.10)" : "transparent",
              color: "#e6edf3",
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Monat
          </button>
          <button
            onClick={async () => {
              setViewMode("list");
              await loadListRange();
            }}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: viewMode === "list" ? "rgba(255,255,255,0.10)" : "transparent",
              color: "#e6edf3",
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Liste
          </button>

<button
  onClick={async () => {
    setViewMode("dashboard");
    await loadListRange();
  }}
  style={{
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.18)",
    background: viewMode === "dashboard" ? "rgba(255,255,255,0.10)" : "transparent",
    color: "#e6edf3",
    fontWeight: 800,
    cursor: "pointer",
  }}
>
  Dashboard
</button>
<button
  onClick={async () => {
    setViewMode("mobile");
    await loadSingleDay(mobileDay);
  }}
  style={{
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.18)",
    background: viewMode === "mobile" ? "rgba(255,255,255,0.10)" : "transparent",
    color: "#e6edf3",
    fontWeight: 800,
    cursor: "pointer",
  }}
>
  Handy
</button>
        </div>

        

{viewMode === "mobile" ? (
          <div className="card" style={{ padding: 16 }}>
            <div
              className="no-print"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 14,
              }}
            >
              <button
                type="button"
                onClick={async () => {
                  const d = parseDateInput(mobileDay) ?? new Date();
                  const prev = addDays(startOfDay(d), -1);
                  const iso = toYMDLocal(prev);
                  setMobileDay(iso);
                  await loadSingleDay(iso);
                }}
                style={{ padding: "9px 12px", borderRadius: 12, fontWeight: 800, cursor: "pointer" }}
                title="Vorheriger Tag"
              >
                ←
              </button>

              <input
                type="date"
                value={mobileDay}
                onChange={async (e) => {
                  const v = e.target.value;
                  setMobileDay(v);
                  if (v) await loadSingleDay(v);
                }}
                style={{
                  padding: "8px 10px",
                  borderRadius: 12,
                  border: "1px solid #273243",
                  background: "transparent",
                  color: "#e6edf3",
                }}
              />

              <button
                type="button"
                onClick={async () => {
                  const d = parseDateInput(mobileDay) ?? new Date();
                  const next = addDays(startOfDay(d), 1);
                  const iso = toYMDLocal(next);
                  setMobileDay(iso);
                  await loadSingleDay(iso);
                }}
                style={{ padding: "9px 12px", borderRadius: 12, fontWeight: 800, cursor: "pointer" }}
                title="Nächster Tag"
              >
                →
              </button>

              <div style={{ opacity: 0.75, fontSize: 13, marginLeft: 8 }}>
                Ein Tag · vertikale Handy-Ansicht
              </div>
            </div>

            <div style={{ maxWidth: 460, width: "100%", margin: "0 auto" }}>
              <PitchDashboardView
                pitches={pitches}
                bookings={filteredBookings}
                from={mobileDay}
                to={mobileDay}
                darkMode={true}
                singleColumn={true}
              />
            </div>
          </div>
        ) : viewMode === "dashboard" ? (
  <div className="card" style={{ padding: 16 }}>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end", marginBottom: 12 }}>
      <div>
        <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 6 }}>Von</div>
        <input
          type="date"
          value={listFrom}
          onChange={(e) => setListFrom(e.target.value)}
          style={{
            padding: "8px 10px",
            borderRadius: 12,
            border: "1px solid #273243",
            background: "transparent",
            color: "#e6edf3",
          }}
        />
      </div>
      <div>
        <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 6 }}>Bis</div>
        <input
          type="date"
          value={listTo}
          onChange={(e) => setListTo(e.target.value)}
          style={{
            padding: "8px 10px",
            borderRadius: 12,
            border: "1px solid #273243",
            background: "transparent",
            color: "#e6edf3",
          }}
        />
      </div>
      <button onClick={loadListRange} style={{ padding: "9px 12px", borderRadius: 12, fontWeight: 800 }}>
        Laden
      </button>
      <div style={{ opacity: 0.75, fontSize: 13, marginLeft: 8 }}>
        Hinweis: Es werden die aktuellen Plätze- und Status-Filter berücksichtigt.
      </div>
    </div>

    <PitchDashboardView pitches={pitches} bookings={filteredBookings} from={listFrom} to={listTo} darkMode={true} />
    {listDays.length === 0 && <div style={{ opacity: 0.8, marginTop: 10 }}>Bitte Zeitraum wählen.</div>}
  </div>
) : viewMode === "week" ? (
          <WeekAgendaView
            rangeStart={weekRange.from}
            rangeEnd={weekRange.to}
            bookings={filteredBookings}
            pitchById={pitchById}
            teamById={teamById}
            onPrevRange={() =>
              setWeekRange((prev) => {
                const span = Math.max(1, Math.floor((prev.to.getTime() - prev.from.getTime()) / 86400000) + 1);
                return { from: addDays(prev.from, -span), to: addDays(prev.to, -span) };
              })
            }
            onNextRange={() =>
              setWeekRange((prev) => {
                const span = Math.max(1, Math.floor((prev.to.getTime() - prev.from.getTime()) / 86400000) + 1);
                return { from: addDays(prev.from, span), to: addDays(prev.to, span) };
              })
            }
            onPresetWeekend={() => setWeekRange(defaultWeekendRange(new Date()))}
            onFromChange={(value) =>
              setWeekRange((prev) => {
                const from = new Date(`${value}T00:00:00`);
                if (Number.isNaN(from.getTime())) return prev;
                const to = prev.to < from ? from : prev.to;
                return { from, to };
              })
            }
            onToChange={(value) =>
              setWeekRange((prev) => {
                const to = new Date(`${value}T00:00:00`);
                if (Number.isNaN(to.getTime())) return prev;
                const from = to < prev.from ? to : prev.from;
                return { from, to };
              })
            }
          />
        ) : viewMode === "month" ? (
          <FullCalendar
            ref={calendarRef as any}
            plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin]}
            initialView={"dayGridMonth"}
            initialDate={initialDate}
            headerToolbar={{
              left: "prev,next today",
              center: "title",
              right: "",
            }}
            buttonText={{
              today: "Heute",
            }}
            locale={deLocale}
            firstDay={1}
            allDaySlot={false}
            weekends
            height="auto"
            events={events}
            datesSet={(arg) => {
              hideTip();
              loadBookings(arg.start, arg.end);
            }}
            eventClassNames={(arg) => {
              const s = String(arg.event.extendedProps.status || "").toUpperCase();
              return [`status-${s}`];
            }}
            selectable={true}
            selectMirror={true}
            unselectAuto={true}
            selectMinDistance={5}
            dateClick={(arg) => {
              hideTip();
              if (arg.view?.type !== "dayGridMonth") return;

              const start = new Date(arg.date);
              start.setHours(12, 0, 0, 0);
              const end = new Date(start.getTime() + 60 * 60 * 1000);

              goToRequestNew(start, end, "dayGridMonth", start);
            }}
            eventMouseEnter={(info) => {
              const text = String(info.event.extendedProps.tooltipText || info.event.title || "");
              const { x, y } = lastMouse.current;

              setTip({ show: true, x: x + 14, y: y + 14, text });
              requestAnimationFrame(() => positionTip(lastMouse.current.x, lastMouse.current.y, text));
            }}
            eventMouseLeave={() => hideTip()}
          />
        ) : (
          <div className="card list-print-root" style={{ padding: 16 }}>
            <div className="no-print" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
              <div>
                <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 6 }}>Von</div>
                <input
                  type="date"
                  value={listFrom}
                  onChange={(e) => setListFrom(e.target.value)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 12,
                    border: "1px solid #273243",
                    background: "transparent",
                    color: "#e6edf3",
                  }}
                />
              </div>
              <div>
                <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 6 }}>Bis</div>
                <input
                  type="date"
                  value={listTo}
                  onChange={(e) => setListTo(e.target.value)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 12,
                    border: "1px solid #273243",
                    background: "transparent",
                    color: "#e6edf3",
                  }}
                />
              </div>
              <button onClick={loadListRange} style={{ padding: "9px 12px", borderRadius: 12, fontWeight: 800 }}>
                Laden
              </button>
              <div style={{ opacity: 0.75, fontSize: 13, marginLeft: 8 }}>
                Hinweis: Es werden die aktuellen Plätze- und Status-Filter berücksichtigt.
              </div>
            </div>

            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              {listDays.map((day) => {
                const dayStart = new Date(day);
                dayStart.setHours(0, 0, 0, 0);
                const dayEnd = addDays(dayStart, 1);

                // bookings that overlap this day
                const dayBookings = filteredBookings.filter((b) => {
                  const bs = new Date(b.start_at);
                  const be = new Date(b.end_at);
                  return bs < dayEnd && be > dayStart;
                });


// Overlap-Layout pro Platz (damit doppelte Buchungen nebeneinander angezeigt werden)
const overlapPosById = new Map<string, { colIndex: number; colCount: number }>();
const minT = new Date(dayStart.getTime() + LIST_START_HOUR * 60 * 60 * 1000);
const maxT = new Date(dayStart.getTime() + LIST_END_HOUR * 60 * 60 * 1000);

for (const p of visiblePitchesForList) {
  const boxes = dayBookings
    .filter((b) => b.pitch_id === p.id)
    .map((b) => {
      const bsRaw = new Date(b.start_at);
      const beRaw = new Date(b.end_at);
      const start = clamp(bsRaw, minT, maxT);
      const end = clamp(beRaw, minT, maxT);
      return { id: b.id, start, end };
    })
    .filter((x) => x.end > x.start);

  const layout = computeOverlapLayout(boxes);
  layout.forEach((pos, id) => overlapPosById.set(id, pos));
}

                return (
                  <div key={day.toISOString()} className={`card print-day ${day === listDays[0] ? "print-day-first" : ""}`} style={{ padding: 12, boxSizing: "border-box" }}>
                    <div className="day-header" style={{ fontWeight: 900, fontSize: 16, marginBottom: 10, paddingLeft: 6 }}>
                      {day.toLocaleDateString("de-DE", {
                        weekday: "long",
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                      })}
                    </div>

                    <div className="print-wrap" style={{ overflowX: "auto", width: "100%", boxSizing: "border-box" }}>
                    <div
                      className="print-grid list-print-grid"
                      style={{
                        display: "grid",
                        ["--pitch-count" as any]: visiblePitchesForList.length,
                        ["--slot-count" as any]: listSlots.length,
                        ["--time-col-width" as any]: "64px",
                        ["--header-row-height" as any]: "30px",
                        ["--slot-row-height" as any]: "14px",
                        minWidth: 64 + visiblePitchesForList.length * 90,
                        width: "max-content",
                        gridTemplateColumns: `64px repeat(${visiblePitchesForList.length}, 225px)`,
                        gridTemplateRows: `30px repeat(${listSlots.length}, 14px)`,
                        gap: 3,
                        boxSizing: "border-box",
                      }}
                    >
                      {/* Header */}
                      <div />
                      {visiblePitchesForList.map((p) => (
                        <div
                          key={p.id}
                          className="print-pitch-header"
                          style={{
                            fontWeight: 800,
                            fontSize: 11,
                            opacity: 0.9,
                            border: "1px solid rgba(255,255,255,0.10)",
                            borderRadius: 10,
                            padding: "6px 8px",
                            background: "rgba(255,255,255,0.04)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={p.name}
                        >
                          {shortenPitchNameForList(p.name)}
                        </div>
                      ))}

                      {/* Time column */}
                      {listSlots.map((s) => (
                        <div
                          key={s.minutes}
                          className="print-time-cell"
                          style={{
                            gridColumn: 1,
                            border: "1px solid rgba(255,255,255,0.08)",
                            borderRadius: 10,
                            padding: "2px 4px",
                            fontSize: 10,
                            opacity: 0.85,
                            background: "rgba(255,255,255,0.03)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {s.label}
                        </div>
                      ))}

                      {/* Empty grid cells */}
                      {visiblePitchesForList.map((p, pi) =>
                        listSlots.map((s, si) => (
                          <div
                            key={`${p.id}-${s.minutes}`}
                            style={{
                              gridColumn: 2 + pi,
                              gridRow: 2 + si,
                              // Option 1: freie Slots "unsichtbar" – keine Boxen, nur eine zarte Linie
                              border: "none",
                              borderTop: "1px solid rgba(255,255,255,0.06)",
                              borderRadius: 0,
                              background: "transparent",
                            }}
                          />
                        ))
                      )}

                      {/* Booking blocks */}
                      {dayBookings.map((b) => {
                        const pIndex = visiblePitchesForList.findIndex((p) => p.id === b.pitch_id);
                        if (pIndex < 0) return null;

                        const bsRaw = new Date(b.start_at);
                        const beRaw = new Date(b.end_at);

                        // clamp to visible hours
                        const minT = new Date(dayStart.getTime() + LIST_START_HOUR * 60 * 60 * 1000);
                        const maxT = new Date(dayStart.getTime() + LIST_END_HOUR * 60 * 60 * 1000);
                        const bs = clamp(bsRaw, minT, maxT);
                        const be = clamp(beRaw, minT, maxT);
                        if (be <= bs) return null;

                        const startIdx = Math.max(
                          0,
                          Math.min(listSlots.length - 1, Math.floor(minutesSinceStart(bs) / SLOT_MIN))
                        );
                        // Ende exklusiv behandeln:
                        // Ein Spiel 14:00–15:00 belegt 14:00–14:30 und 14:30–15:00,
                        // aber NICHT schon den Slot ab 15:00.
                        const endIdx = Math.max(
                          startIdx + 1,
                          Math.min(listSlots.length, Math.ceil(minutesSinceStart(be) / SLOT_MIN))
                        );

                        const status = String(b.status || "").toUpperCase();
                        const bg = status === "APPROVED" ? "rgba(40, 160, 80, 0.25)" : "rgba(210, 160, 0, 0.20)";
                        const border =
                          status === "APPROVED" ? "rgba(40, 160, 80, 0.55)" : "rgba(210, 160, 0, 0.45)";

                        const dashboardLabel = cleanIcsLikeText(bookingLabelLikeDashboard(b));
                        const rawIcs = String(b?.note || (b as any)?.tooltipText || (b as any)?.title || "");
                        const metaSource = cleanIcsLikeText(rawIcs || dashboardLabel);
                        const tName = dashboardLabel.split(",")[0]?.trim() || dashboardLabel || "—";
                        const matchType = detectMatchType(metaSource);
                        const competition = extractCompetitionFromIcs(metaSource);
                        const timeLabel = `${fmtTime(b.start_at)}–${fmtTime(b.end_at)}`;


const pos = overlapPosById.get(b.id) ?? { colIndex: 0, colCount: 1 };
const gapPx = 6;
const w =
  pos.colCount > 1
    ? `calc((100% - ${(pos.colCount - 1) * gapPx}px) / ${pos.colCount})`
    : "100%";
const ml =
  pos.colCount > 1
    ? `calc(${pos.colIndex} * (((100% - ${(pos.colCount - 1) * gapPx}px) / ${pos.colCount}) + ${gapPx}px))`
    : "0px";

return (
                          <div
                            key={b.id}
                            className="print-event"
                            title={`${timeLabel}\n${tName}${matchType ? `\n${matchType}` : ""}${competition ? `\n${competition}` : ""}`}
                            style={{
                              gridColumn: 2 + pIndex,
                              gridRowStart: 2 + startIdx,
                              gridRowEnd: 2 + endIdx,
                              zIndex: 3,
                              borderRadius: 10,
                              border: `1px solid ${border}`,
                              background: bg,
                              padding: "4px 6px",
                              width: w,
                              marginLeft: ml,
                              overflowX: "hidden",
                              overflowY: "hidden",
                              display: "flex",
                              flexDirection: "column",
                              justifyContent: "center",
                              gap: 1,
                              fontSize: 11,
                            }}
                          >
                            <div
                              style={{
                                fontWeight: 800,
                                marginBottom: 1,
                                whiteSpace: "normal",
                                overflow: "hidden",
                                textOverflow: "clip",
                                wordBreak: "break-word",
                                lineHeight: 1.12,
                                display: "-webkit-box",
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical" as const,
                              }}
                            >
                              {tName}
                            </div>
                            <div style={{ opacity: 0.95, fontSize: 10, marginBottom: 1, whiteSpace: "nowrap" }}>{timeLabel}</div>
                            {(matchType || competition) ? (
                              <div
                                style={{
                                  opacity: 0.86,
                                  fontSize: 10,
                                  lineHeight: 1.1,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {[matchType, competition].filter(Boolean).join(" | ")}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    </div>
                  </div>
                );
              })}

              {listDays.length === 0 && <div style={{ opacity: 0.8 }}>Bitte Zeitraum wählen.</div>}
            </div>
          </div>
        )}

        {/* Tooltip */}
        {tip.show && (
          <div
            style={{
              position: "fixed",
              left: tip.x,
              top: tip.y,
              zIndex: 9999,
              width: 360,
              maxWidth: "calc(100vw - 20px)",
              background: "rgba(10, 20, 30, 0.95)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 12,
              padding: 16,
              fontSize: 13,
              lineHeight: 1.25,
              whiteSpace: "pre-wrap",
              pointerEvents: "none",
            }}
          >
            {tip.text}
          </div>
        )}
      </div>
    </div>
  );
}