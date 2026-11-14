import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Unread counts for the strip's green notification dots.
 *
 * `call_history` and `voicemails` have no read flag, so "new" means "created
 * since the user last opened that panel" — the timestamp is kept in
 * localStorage so it survives a relaunch. Team messages have a real `read`
 * column and use it.
 */

const SEEN_KEY = "gc-sidebar-seen";

type SeenMap = Record<string, string>;

function readSeen(): SeenMap {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") as SeenMap;
  } catch {
    return {};
  }
}

function writeSeen(next: SeenMap) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; badges just fall back to "everything is new".
  }
}

export interface SidebarBadges {
  recents: number;
  voicemail: number;
  messages: number;
}

const MISSED_STATUSES = ["no-answer", "busy", "failed", "missed"];

export function useSidebarBadges(userId?: string, accountType?: string) {
  const [badges, setBadges] = useState<SidebarBadges>({ recents: 0, voicemail: 0, messages: 0 });

  const refresh = useCallback(async () => {
    if (!userId) {
      setBadges({ recents: 0, voicemail: 0, messages: 0 });
      return;
    }

    const seen = readSeen();
    // First run: treat "now" as the baseline so the strip doesn't open with a
    // dot for every historical missed call.
    const since = (key: string) => seen[key] || new Date().toISOString();

    const [missedRes, vmRes, msgRes] = await Promise.all([
      supabase
        .from("call_history")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("direction", "inbound")
        .in("status", MISSED_STATUSES)
        .gt("created_at", since("recents")),
      supabase
        .from("voicemails")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .gt("created_at", since("voicemail")),
      accountType === "enterprise"
        ? supabase
            .from("team_messages")
            .select("*", { count: "exact", head: true })
            .eq("to_user_id", userId)
            .eq("read", false)
        : Promise.resolve({ count: 0 }),
    ]);

    setBadges({
      recents: missedRes.count || 0,
      voicemail: vmRes.count || 0,
      messages: (msgRes as { count: number | null }).count || 0,
    });
  }, [userId, accountType]);

  /** Called when the user opens a panel — clears that panel's dot. */
  const markSeen = useCallback(
    (key: keyof SidebarBadges) => {
      if (key === "messages") return; // driven by the real `read` column
      const seen = readSeen();
      seen[key] = new Date().toISOString();
      writeSeen(seen);
      setBadges((prev) => ({ ...prev, [key]: 0 }));
    },
    [],
  );

  useEffect(() => {
    if (!userId) return;

    // Seed the baseline on first ever run.
    const seen = readSeen();
    let touched = false;
    (["recents", "voicemail"] as const).forEach((k) => {
      if (!seen[k]) {
        seen[k] = new Date().toISOString();
        touched = true;
      }
    });
    if (touched) writeSeen(seen);

    refresh();

    const channel = supabase
      .channel(`sidebar-badges-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "call_history", filter: `user_id=eq.${userId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "voicemails", filter: `user_id=eq.${userId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "team_messages", filter: `to_user_id=eq.${userId}` }, refresh)
      .subscribe();

    // Realtime can miss events; a slow poll keeps the dots honest.
    const interval = window.setInterval(refresh, 30_000);

    return () => {
      supabase.removeChannel(channel);
      window.clearInterval(interval);
    };
  }, [userId, refresh]);

  return { badges, markSeen, refresh };
}
