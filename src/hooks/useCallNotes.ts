import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface CallNote {
  id: string;
  user_id: string;
  call_ref: string;
  call_history_id: string | null;
  phone_number: string | null;
  contact_name: string | null;
  direction: string | null;
  duration: number | null;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface SaveCallNoteParams {
  userId: string;
  /** Stable client-side identifier for the call (generated when the call goes active). */
  callRef: string;
  note: string;
  phoneNumber?: string | null;
  contactName?: string | null;
  direction?: "inbound" | "outbound" | null;
  duration?: number | null;
}

/** Fetch the existing note for a call by its stable client-side ref. */
export async function getCallNote(userId: string, callRef: string): Promise<CallNote | null> {
  const { data, error } = await supabase
    .from("call_notes")
    .select("*")
    .eq("user_id", userId)
    .eq("call_ref", callRef)
    .maybeSingle();
  if (error) {
    console.error("getCallNote error:", error);
    return null;
  }
  return (data as CallNote) ?? null;
}

/**
 * Upsert a note for a call (one row per user_id + call_ref). An empty note removes
 * any existing row so we never accumulate blank notes.
 */
export async function saveCallNote(params: SaveCallNoteParams): Promise<CallNote | null> {
  const { userId, callRef } = params;
  const note = (params.note ?? "").trim();

  if (!note) {
    await supabase.from("call_notes").delete().eq("user_id", userId).eq("call_ref", callRef);
    return null;
  }

  const { data, error } = await supabase
    .from("call_notes")
    .upsert(
      {
        user_id: userId,
        call_ref: callRef,
        note,
        phone_number: params.phoneNumber ?? null,
        contact_name: params.contactName ?? null,
        direction: params.direction ?? null,
        duration: params.duration ?? 0,
      },
      { onConflict: "user_id,call_ref" }
    )
    .select()
    .maybeSingle();

  if (error) {
    console.error("saveCallNote error:", error);
    return null;
  }
  return data as CallNote;
}

/** List + manage all of a user's call notes (for the Notes tab). */
export function useCallNotes(userId?: string) {
  const [notes, setNotes] = useState<CallNote[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) {
      setNotes([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("call_notes")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) console.error("useCallNotes fetch error:", error);
    setNotes((data as CallNote[]) || []);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep the list live as notes are written during/after calls.
  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`call_notes:${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "call_notes", filter: `user_id=eq.${userId}` },
        () => refresh()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, refresh]);

  const deleteNote = useCallback(
    async (id: string) => {
      const { error } = await supabase.from("call_notes").delete().eq("id", id);
      if (error) console.error("deleteNote error:", error);
      else refresh();
    },
    [refresh]
  );

  const updateNote = useCallback(
    async (id: string, note: string) => {
      const trimmed = note.trim();
      if (!trimmed) {
        await deleteNote(id);
        return;
      }
      const { error } = await supabase.from("call_notes").update({ note: trimmed }).eq("id", id);
      if (error) console.error("updateNote error:", error);
      else refresh();
    },
    [refresh, deleteNote]
  );

  return { notes, loading, refresh, updateNote, deleteNote };
}
