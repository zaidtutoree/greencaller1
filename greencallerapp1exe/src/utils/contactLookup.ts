import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Resolve a saved contact's name for a phone number, tolerating format
// differences (missing +, spaces, brackets, country-code prefixes).

export function normalizePhone(raw?: string | null): string {
  if (!raw) return "";
  return raw.replace(/\D/g, "");
}

/**
 * True if two numbers are "the same" allowing for formatting/country-code
 * differences. Exact match, or one is a suffix of the other sharing at least
 * 7 trailing digits (e.g. +442046203845 vs 442046203845 vs 02046203845).
 */
export function phoneMatches(a?: string | null, b?: string | null): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  if (shorter.length < 7) return false;
  return longer.endsWith(shorter);
}

interface ContactLite {
  name: string;
  phone_number: string;
}

interface CacheEntry {
  userId: string;
  at: number;
  contacts: ContactLite[];
}

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry | null> | null = null;
const TTL_MS = 30_000;

/** Drop the cache so the next lookup refetches (call after add/delete). */
export function invalidateContactsCache(): void {
  cache = null;
}

async function loadContacts(): Promise<CacheEntry | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  if (cache && cache.userId === user.id && Date.now() - cache.at < TTL_MS) {
    return cache;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const { data } = await supabase
      .from("user_contacts")
      .select("name, phone_number")
      .eq("user_id", user.id);
    cache = { userId: user.id, at: Date.now(), contacts: data || [] };
    inflight = null;
    return cache;
  })();

  return inflight;
}

export async function resolveContactName(phone?: string | null): Promise<string | null> {
  if (!phone) return null;
  const entry = await loadContacts();
  if (!entry) return null;
  const match = entry.contacts.find((c) => phoneMatches(c.phone_number, phone));
  return match?.name || null;
}

/**
 * Returns the best display name for a call: a saved contact's name if the
 * number matches one, otherwise the provided fallback (e.g. the network's
 * caller name). Updates asynchronously once contacts load.
 */
export function useContactName(phone?: string | null, fallback?: string): string | undefined {
  const [name, setName] = useState<string | undefined>(fallback);

  useEffect(() => {
    let active = true;
    setName(fallback);
    resolveContactName(phone).then((n) => {
      if (active && n) setName(n);
    });
    return () => {
      active = false;
    };
  }, [phone, fallback]);

  return name;
}
