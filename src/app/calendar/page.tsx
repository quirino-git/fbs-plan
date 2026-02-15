"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import deLocale from "@fullcalendar/core/locales/de";

import { supabase } from "@/lib/supabaseClient";

type Pitch = { id: string; name: string; type: "GROSSFELD" | "KOMPAKT" };
type Team = { id: string; name: string; age_u: number };

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

type Profile = {
  id: string;
  full_name: string | null;
  role: string | null;
  active: boolean | null;
};

function roundToStep(date: Date, stepMinutes: number) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  const rounded = Math.round(m / stepMinutes) * stepMinutes;
  d.setMinutes(rounded);
  return d;
}

function toLocalInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toYMD(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function goToRequestNew(start: Date, end: Date, returnView: string, returnDate: Date) {
  const params = new URLSearchParams({
    start: toLocalInputValue(start),
    end: toLocalInputValue(end),
    returnView,
    returnDate: toYMD(returnDate),
  });
  window.location.href = `/request/new?${params.toString()}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/** Kleine UI-Hilfe: Checkbox-Dropdown */
function MultiSelectDropdown<T extends string>({
  label,
  options,
  selected,
  setSelected,
  defaultSelected,
  allSelected,
}: {
  label: string;
  options: { value: T; label: string }[];
  selected: T[];
  setSelected: (v: T[]) => void;
  defaultSelected: T[];
  allSelected: T[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const el = ref.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const summary =
    selected.length === allSelected.length
      ? "Alle"
      : selected.length === 0
        ? "Keine"
        : options
            .filter((o) => selected.includes(o.value))
            .map((o) => o.label)
            .join(", ");

  return (
    <div ref={ref} style={{ position: "relative", minWidth: 260 }}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "10px 12px",
          borderRadius: 12,
          border: "1px solid #273243",
          background: "rgba(255,255,255,0.03)",
          cursor: "pointer",
        }}
      >
        <div style={{ fontWeight: 700 }}>
          {label} ({selected.length})
        </div>
        <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {summary}
        </div>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            zIndex: 1000,
            width: "100%",
            background: "rgba(15, 22, 32, 0.98)",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 12,
            padding: 10,
            boxShadow: "0 14px 40px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => setSelected(defaultSelected)}
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #273243", cursor: "pointer" }}
            >
              Default
            </button>
            <button
              type="button"
              onClick={() => setSelected(allSelected)}
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #273243", cursor: "pointer" }}
            >
              Alle
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{ marginLeft: "auto", padding: "8px 10px", borderRadius: 10, border: "1px solid #273243", cursor: "pointer" }}
            >
              Schließen
            </button>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {options.map((o) => {
              const checked = selected.includes(o.value);
              return (
                <label
                  key={o.value}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    padding: "10px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.12)",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setSelected(
                        checked ? selected.filter((x) => x !== o.value) : [...selected, o.value]
                      );
                    }}
                    style={{ width: 18, height: 18 }}
                  />
                  <div style={{ fontWeight: 700 }}>{o.label}</div>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CalendarPage() {
  const ENABLE_BFV = process.env.NEXT_PUBLIC_ENABLE_BFV === "true";

  const [sessionChecked, setSessionChecked] = useState(false);

  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);

  const [error, setError] = useState<string | null>(null);

  // Multi-Select: Plätze (default = alle)
  const [pitchFilterIds, setPitchFilterIds] = useState<string[]>([]);

  // Multi-Select: Status (default = requested + approved)
  const STATUS_OPTIONS = useMemo(
    () => [
      { value: "REQUESTED" as const, label: "Angefragt" },
      { value: "APPROVED" as const, label: "Genehmigt" },
      { value: "REJECTED" as const, label: "Abgelehnt" },
    ],
    []
  );
  const DEFAULT_STATUS = useMemo(() => ["REQUESTED", "APPROVED"] as const, []);
  const ALL_STATUS = useMemo(() => ["REQUESTED", "APPROVED", "REJECTED"] as const, []);
  const [statusFilter, setStatusFilter] = useState<string[]>([...DEFAULT_STATUS]);

  // -------------------------
  // Tooltip (Blase)
  // -------------------------
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<{ show: boolean; x: number; y: number; text: string }>({
    show: false,
    x: 0,
    y: 0,
    text: "",
  });

  const lastMouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  function hideTip() {
    setTip((t) => (t.show ? { ...t, show: false } : t));
  }

  function positionTip(clientX: number, clientY: number, text: string) {
    const padding = 12;
    const offset = 14;

    const el = tooltipRef.current;
    const w = el?.offsetWidth ?? 360;
    const h = el?.offsetHeight ?? 140;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = clientX + offset;
    let y = clientY + offset;

    x = clamp(x, padding, vw - w - padding);
    y = clamp(y, padding, vh - h - padding);

    setTip({ show: true, x, y, text });
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      lastMouse.current = { x: e.clientX, y: e.clientY };

      const target = e.target as HTMLElement | null;
      const overEvent = !!target?.closest?.(".fc-event");
      if (!overEvent) {
        hideTip();
        return;
      }

      if (!tip.show) return;
      positionTip(e.clientX, e.clientY, tip.text);
    }

    function onScrollOrResize() {
      hideTip();
    }

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [tip.show, tip.text]);

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

      setUserEmail(session.user.email ?? null);

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

  async function loadBaseData() {
    setError(null);

    const [p, t] = await Promise.all([
      supabase.from("pitches").select("*").order("name"),
      supabase.from("teams").select("*").order("age_u").order("name"),
    ]);

    if (p.error) return setError(p.error.message);
    if (t.error) return setError(t.error.message);

    const pitchList = (p.data ?? []) as Pitch[];
    setPitches(pitchList);
    setTeams((t.data ?? []) as Team[]);

    // Default: alle Plätze selektiert (wenn noch leer)
    setPitchFilterIds((prev) => (prev.length ? prev : pitchList.map((x) => x.id)));
  }

  async function loadBookings(rangeStart: Date, rangeEnd: Date) {
    setError(null);

    const startISO = rangeStart.toISOString();
    const endISO = rangeEnd.toISOString();

    const { data, error } = await supabase
      .from("bookings")
      .select("id,start_at,end_at,status,note,team_id,pitch_id,created_by")
      .gte("start_at", startISO)
      .lt("end_at", endISO);

    if (error) return setError(error.message);
    setBookings((data ?? []) as Booking[]);
  }

  // initial load + realtime
  useEffect(() => {
    if (!sessionChecked) return;

    loadBaseData();

    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    const end = new Date(now);
    end.setDate(now.getDate() + 14);
    loadBookings(start, end);

    const channel = supabase
      .channel("bookings-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, () => {
        const n = new Date();
        const s = new Date(n);
        s.setDate(n.getDate() - 7);
        const e = new Date(n);
        e.setDate(n.getDate() + 14);
        loadBookings(s, e);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionChecked]);

  const pitchById = useMemo(() => new Map(pitches.map((x) => [x.id, x])), [pitches]);
  const teamById = useMemo(() => new Map(teams.map((x) => [x.id, x])), [teams]);

  const events = useMemo(() => {
    const selectedStatus = new Set(statusFilter.map((s) => String(s).toUpperCase()));
    const selectedPitches = new Set(pitchFilterIds);

    return bookings
      .filter((b) => selectedPitches.has(b.pitch_id))
      .filter((b) => selectedStatus.has(String(b.status || "").toUpperCase()))
      .map((b) => {
        const pitch = pitchById.get(b.pitch_id)?.name ?? "Platz";
        const team = teamById.get(b.team_id)?.name ?? "Team";
        const status = String(b.status || "").toUpperCase();

        const tooltipText = [
          `${pitch} – ${team}`,
          `Status: ${status}`,
          `Von: ${new Date(b.start_at).toLocaleString("de-DE")}`,
          `Bis: ${new Date(b.end_at).toLocaleString("de-DE")}`,
          b.note ? `Notiz: ${b.note}` : null,
        ]
          .filter(Boolean)
          .join("\n");

        return {
          id: b.id,
          title: `${pitch} – ${team} (${status})`,
          start: b.start_at,
          end: b.end_at,
          extendedProps: { status, tooltipText },
        };
      });
  }, [bookings, pitchFilterIds, statusFilter, pitchById, teamById]);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  if (!sessionChecked) return null;

  const role = (profile?.role || "TRAINER").toUpperCase();
  const activeText = profile?.active === false ? "inaktiv" : "aktiv";
  const displayName = (profile?.full_name && profile.full_name.trim()) || userEmail || "User";
  const isAdmin = role === "ADMIN";

  // Restore view + date from URL
  const url = new URL(window.location.href);
  const viewParam = url.searchParams.get("view") || "timeGridWeek";
  const dateParam = url.searchParams.get("date"); // YYYY-MM-DD
  const initialView = viewParam === "dayGridMonth" || viewParam === "timeGridWeek" ? viewParam : "timeGridWeek";
  const initialDate = dateParam ? new Date(`${dateParam}T12:00:00`) : undefined;

  return (
    <div style={{ maxWidth: 1200, margin: "24px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "12px 14px",
          border: "1px solid #273243",
          borderRadius: 12,
          background: "rgba(255,255,255,0.03)",
        }}
      >
        <div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>FC Stern – Platzbelegung</div>
          <div style={{ opacity: 0.8, fontSize: 13 }}>
            {displayName} • Rolle: {role} • {activeText}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Link
            href="/request/new"
            style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #273243", textDecoration: "none" }}
          >
            + Antrag
          </Link>

          <Link
            href="/approve"
            style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #273243", textDecoration: "none" }}
          >
            {isAdmin ? "Genehmigen" : "Genehmigungen"}
          </Link>

          {/* ✅ BFV Button wieder sichtbar (nur Admin + Toggle) */}
          {isAdmin && ENABLE_BFV && (
            <Link
              href="/bfv"
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #273243",
                textDecoration: "none",
              }}
            >
              Ligaspiele planen (BFV)
            </Link>
          )}

          <button
            onClick={logout}
            style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #273243", cursor: "pointer" }}
          >
            Logout
          </button>
        </div>
      </div>

      {/* Filter */}
      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <MultiSelectDropdown
          label="Plätze"
          options={pitches.map((p) => ({ value: p.id, label: p.name }))}
          selected={pitchFilterIds}
          setSelected={setPitchFilterIds}
          defaultSelected={pitches.map((p) => p.id)}
          allSelected={pitches.map((p) => p.id)}
        />

        <MultiSelectDropdown
          label="Status"
          options={STATUS_OPTIONS as any}
          selected={statusFilter as any}
          setSelected={(v) => setStatusFilter(v as any)}
          defaultSelected={[...DEFAULT_STATUS] as any}
          allSelected={[...ALL_STATUS] as any}
        />
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {/* Kalender */}
      <div style={{ marginTop: 16, position: "relative" }}>
        <FullCalendar
          plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin]}
          initialView={initialView}
          initialDate={initialDate}
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "timeGridWeek,dayGridMonth",
          }}
          buttonText={{
            today: "Heute",
            timeGridWeek: "Woche",
            dayGridMonth: "Monat",
          }}
          locale={deLocale}
          firstDay={1}
          slotMinTime="06:00:00"
          slotMaxTime="23:00:00"
          allDaySlot={false}
          slotDuration="00:30:00"
          snapDuration="00:30:00"
          nowIndicator
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
          select={(arg) => {
            hideTip();
            if (arg.view?.type !== "timeGridWeek") return;

            const step = 30;
            const start = roundToStep(arg.start, step);
            const end = roundToStep(arg.end, step);

            const startMs = start.getTime();
            const endMs = end.getTime();
            const durationMin = (endMs - startMs) / 60000;

            const finalEnd =
              !Number.isFinite(durationMin) || durationMin < 30 ? new Date(startMs + 60 * 60 * 1000) : end;

            goToRequestNew(start, finalEnd, "timeGridWeek", start);
          }}
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

        {tip.show && (
          <div
            ref={tooltipRef}
            style={{
              position: "fixed",
              left: tip.x,
              top: tip.y,
              zIndex: 9999,
              whiteSpace: "pre-line",
              background: "rgba(15, 22, 32, 0.98)",
              color: "#e6edf3",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 10,
              padding: "10px 12px",
              maxWidth: 360,
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              pointerEvents: "none",
              fontSize: 13,
              lineHeight: 1.35,
            }}
          >
            {tip.text}
          </div>
        )}
      </div>
    </div>
  );
}
