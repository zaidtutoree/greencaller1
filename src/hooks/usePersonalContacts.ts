import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { invalidateContactsCache } from "@/utils/contactLookup";

export interface UserContact {
  id: string;
  name: string;
  phone_number: string;
  email: string | null;
  created_at: string | null;
}

export interface NewContact {
  name: string;
  phone_number: string;
  email?: string | null;
}

/**
 * The user's personal contacts (`user_contacts`, shared with the mobile app).
 * Realtime keeps every surface in step, and the shared caller-name cache is
 * invalidated on writes so live-call screens pick names up immediately.
 */
export function usePersonalContacts(userId?: string) {
  const [contacts, setContacts] = useState<UserContact[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) {
      setContacts([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("user_contacts")
      .select("id, name, phone_number, email, created_at")
      .eq("user_id", userId)
      .order("name", { ascending: true });
    if (error) console.error("Error fetching contacts:", error);
    else setContacts(data || []);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    refresh();
    if (!userId) return;
    const channel = supabase
      .channel(`user_contacts_${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "user_contacts", filter: `user_id=eq.${userId}` },
        () => refresh(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, refresh]);

  const addContact = useCallback(
    async (c: NewContact) => {
      if (!userId) return { error: new Error("Not signed in") };
      const { error } = await supabase.from("user_contacts").insert({
        user_id: userId,
        name: c.name.trim(),
        phone_number: c.phone_number.trim(),
        email: c.email?.trim() || null,
      });
      if (!error) {
        invalidateContactsCache();
        refresh();
      }
      return { error };
    },
    [userId, refresh],
  );

  const deleteContact = useCallback(
    async (id: string) => {
      const { error } = await supabase.from("user_contacts").delete().eq("id", id);
      if (!error) {
        invalidateContactsCache();
        refresh();
      }
      return { error };
    },
    [refresh],
  );

  return { contacts, loading, refresh, addContact, deleteContact };
}

export const contactInitials = (name: string) => {
  if (!name) return "?";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
};

const AVATAR_COLORS = [
  "bg-emerald-500", "bg-teal-500", "bg-rose-500", "bg-amber-500",
  "bg-cyan-600", "bg-orange-500", "bg-indigo-500", "bg-fuchsia-500",
];

/** Stable avatar colour per contact name. */
export const contactColor = (name: string) => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};
