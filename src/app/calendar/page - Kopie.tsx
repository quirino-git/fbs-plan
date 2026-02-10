"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

function toYMD(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export default function CalendarPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [sessionChecked, setSessionChecked] = useState(false);

  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);

  const [error, setError] = useState<string | null>(null);

  const [pitchFilter, setPitchFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  // -------------------------
  // Tooltip
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
  // Restore view + date from URL
  // -------------------------
  const initialView = useMemo(() => {
    const v = searchParams.get("view") || "timeGridWeek";
    return v === "dayGridMonth" || v === "timeGridWeek" ? v : "timeGridWeek";
  }, [searchParams]);

  const initialDate = useMemo(() => {
    const d = searchParams.get("date");
    if (!d) return undefined;
    return new Date(`${d}T12:00:00`);
  }, [searchParams]);

  // -------------------------
  // Merke aktuelle View/Date (für "+ Antrag")
  // -------------------------
  const [currentView, setCurrentView] = useState<string>(initialView);
  const [currentAnchorDate, setCurrentAnchorDate] = useState<Date | null>(initialDate ?? null);

  // -------------------------
  // Navigation: zum Antrag
  // -------------------------
  function goToRequestNew(start: Date, end: Date, returnView: string, returnDate: Date) {
    const params = new URLSearchParams({
      start: toLocalInputValue(start),
      end: toLocalInputValue(end),
      returnView,
      returnDate: toYMD(returnDate),
    });

    router.push(`/request/new?${params.toString()}`);
  }

  // "+ Antrag" soll genauso zurückspringen wie Klick/Drag im Kalender
  const requestHref = useMemo(() => {
    const view = (currentView === "dayGridMonth" || currentView === "timeGridWeek") ? currentView : "timeGridWeek";

    // Anchor-Date: wenn wir sie noch nicht haben, nimm "heute"
    const anchor = currentAnchorDate ?? new Date();

    // Defaults fürs Formular:
    // - Woche: nächste halbe Stunde, Dauer 60
    // - Monat: 12:00–13:00
    let start: Date;
    let end: Date;

    if (view === "dayGridMonth") {
      start = new Date(anchor);
      start.setHours(12, 0, 0, 0);
      end = new Date(start.getTime() + 60 * 60 * 1000);
    } else {
      const now = new Date();
      start = roundToStep(now, 30);
      end = new Date(start.getTime() + 60 * 60 * 1000);
    }

    const params = new URLSearchParams({
      start: toLocalInputValue(start),
      end: toLocalInputValue(end),
      returnView: view,
      returnDate: toYMD(anchor),
    });

    return `/request/new?${params.toString()}`;
  }, [currentView, currentAnchorDate]);

  // -------------------------
  // Session + Profil laden
  // -------------------------
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;

      if (!session) {
        router.replace("/login");
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
  }, [router]);

  async function loadBaseData() {
    setError(null);

    const [p, t] = await Promise.all([
      supabase.from("pitches").select("*").order("name"),
      supabase.from("teams").select("*").order("age_u").order("name"),
    ]);

    if (p.error) return setError(p.error.message);
    if (t.error) return setError(t.error.message);

    setPitches((p.data ?? []) as Pitch[]);
    setTeams((t.data ?? []) as Team[]);
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
    return bookings
      .filter((b) => (pitchFilter === "ALL" ? true : b.pitch_id === pitchFilter))
      .filter((b) => (statusFilter === "ALL" ? true : b.status === statusFilter))
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
  }, [bookings, pitchFilter, statusFilter, pitchById, teamById]);

  async function logout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  if (!sessionChecked) return null;

  const role = (profile?.role || "TRAINER").toUpperCase();
  const activeText = profile?.active === false ? "inaktiv" : "aktiv";
  const displayName = (profile?.full_name && profile.full_name.trim()) || userEmail || "User";
  const isAdmin = role === "ADMIN";

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
          {/* ✅ Wichtig: "+ Antrag" nimmt aktuelle View/Date mit */}
          <Link
            href={requestHref}
            style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #273243", textDecoration: "none" }}
          >
            + Antrag
          </Link>

          {isAdmin && (
            <Link
              href="/approve"
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #273243", textDecoration: "none" }}
            >
              Genehmigen
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
      <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        <label>
          Platz:&nbsp;
          <select value={pitchFilter} onChange={(e) => setPitchFilter(e.target.value)}>
            <option value="ALL">Alle</option>
            {pitches.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Status:&nbsp;
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="ALL">Alle</option>
            <option value="REQUESTED">REQUESTED</option>
            <option value="APPROVED">APPROVED</option>
            <option value="REJECTED">REJECTED</option>
            <option value="NEEDS_INFO">NEEDS_INFO</option>
            <option value="CHANGED">CHANGED</option>
            <option value="CANCELLED">CANCELLED</option>
          </select>
        </label>
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
            // ✅ Merken, wo wir gerade sind (View + "Anchor"-Datum)
            setCurrentView(arg.view.type);
            setCurrentAnchorDate(arg.view.currentStart);

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
          // Woche: Drag/Markieren -> Antrag
          select={(arg) => {
            hideTip();
            if (arg.view?.type !== "timeGridWeek") return;

            const step = 30;
            const start = roundToStep(arg.start, step);
            const end = roundToStep(arg.end, step);

            const durationMin = (end.getTime() - start.getTime()) / 60000;
            const finalEnd =
              !Number.isFinite(durationMin) || durationMin < 30 ? new Date(start.getTime() + 60 * 60000) : end;

            goToRequestNew(start, finalEnd, "timeGridWeek", start);
          }}
          // Monat: Klick auf Tag -> Antrag 12:00–13:00
          dateClick={(arg) => {
            hideTip();
            if (arg.view?.type !== "dayGridMonth") return;

            const start = new Date(arg.date);
            start.setHours(12, 0, 0, 0);
            const end = new Date(start.getTime() + 60 * 60 * 1000);

            goToRequestNew(start, end, "dayGridMonth", start);
          }}
          // Tooltip
          eventMouseEnter={(info) => {
            const text = String(info.event.extendedProps.tooltipText || info.event.title || "");
            const { x, y } = lastMouse.current;

            setTip({ show: true, x: x + 14, y: y + 14, text });
            requestAnimationFrame(() => positionTip(lastMouse.current.x, lastMouse.current.y, text));
          }}
          eventMouseLeave={() => hideTip()}
        />

        {/* Tooltip Layer */}
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
