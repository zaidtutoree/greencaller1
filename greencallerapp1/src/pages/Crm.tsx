import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  FileSpreadsheet,
  GripVertical,
  ListChecks,
  Loader2,
  LogOut,
  Plus,
  Scissors,
  Search,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { parseCsv, toCsv } from "@/lib/csv";
import logo from "@/assets/greencaller-full-logo.png";

/* ───────────────────────────── config ───────────────────────────── */

/** The only account allowed into the CRM. The DB enforces the same rule via RLS. */
const ALLOWED_EMAIL = "zaid@greencaller.co.uk";
const PAGE_SIZE = 50;
const SAVE_DEBOUNCE_MS = 900;
const DEFAULT_COLUMNS = ["Name", "Company", "Phone", "Email", "Status", "Notes"];

/* ───────────────────────────── types ───────────────────────────── */

interface Sheet {
  id: string;
  name: string;
  columns: string[];
  rows: string[][];
  updated_at: string;
}

type SaveState = "saved" | "dirty" | "saving" | "error";

const isAllowed = (email?: string | null) => (email || "").trim().toLowerCase() === ALLOWED_EMAIL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normaliseSheet = (raw: any): Sheet => ({
  id: raw.id,
  name: raw.name ?? "Untitled list",
  columns: Array.isArray(raw.columns) ? raw.columns.map((c: unknown) => String(c ?? "")) : [],
  rows: Array.isArray(raw.rows)
    ? raw.rows.map((r: unknown) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : []))
    : [],
  updated_at: raw.updated_at,
});

/* ───────────────────────────── login ───────────────────────────── */

const CrmLogin = () => {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAllowed(email)) {
      toast({
        title: "Not allowed",
        description: "This CRM is restricted to a single account.",
        variant: "destructive",
      });
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      toast({ title: "Sign in failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <header className="border-b border-border/40 bg-white px-6 py-3">
        <img src={logo} alt="Greencaller" className="h-10 w-auto" />
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="rounded-lg border border-border/60 bg-white p-8 shadow-sm md:p-10">
            <div className="mb-8">
              <Badge variant="secondary" className="mb-3 gap-1 font-normal">
                <Table2 className="h-3 w-3" /> CRM
              </Badge>
              <h1 className="mb-2 text-2xl font-semibold text-foreground">Sign in to CRM</h1>
              <p className="text-sm text-muted-foreground">
                Upload your cold-calling lists and keep them up to date. Access is restricted to one account.
              </p>
            </div>
            <form onSubmit={submit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="crm-email">Email</Label>
                <Input
                  id="crm-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="Enter email address"
                  autoComplete="email"
                  className="h-11 bg-white"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="crm-password">Password</Label>
                <Input
                  id="crm-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  className="h-11 bg-white"
                />
              </div>
              <Button type="submit" className="mt-6 h-11 w-full" disabled={loading}>
                {loading ? "Please wait…" : "Continue"}
              </Button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
};

/* ───────────────────────────── page ───────────────────────────── */

const Crm = () => {
  const { toast } = useToast();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(false);

  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [search, setSearch] = useState("");
  /** Column index to search in, or -1 for every column. */
  const [searchCol, setSearchCol] = useState(-1);
  const [page, setPage] = useState(0);

  /** Selected rows as ORIGINAL row indexes (stable across search filtering). */
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  /** Anchor for shift-click range selection (original row index). */
  const lastClicked = useRef<number | null>(null);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");

  /** Column drag-and-drop reordering. */
  const [dragCol, setDragCol] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<number | null>(null);

  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [split, setSplit] = useState<{ mode: "move" | "copy"; name: string } | null>(null);
  const [splitBusy, setSplitBusy] = useState(false);
  const [confirm, setConfirm] = useState<
    | { kind: "sheet"; id: string; label: string }
    | { kind: "column"; index: number; label: string }
    | { kind: "rows"; count: number }
    | null
  >(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<number | null>(null);
  /** Sheets with unsaved edits, keyed by id. Flushed on debounce, switch and unload. */
  const pending = useRef<Map<string, Sheet>>(new Map());

  const allowed = isAllowed(session?.user?.email);
  const active = useMemo(() => sheets.find((s) => s.id === activeId) ?? null, [sheets, activeId]);

  // ── Session ────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setSessionReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setSheets([]);
        setActiveId(null);
        pending.current.clear();
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // ── Load sheets ────────────────────────────────────────────────────────
  const loadSheets = useCallback(async () => {
    setSheetsLoading(true);
    const { data, error } = await supabase
      .from("crm_sheets")
      .select("id, name, columns, rows, updated_at")
      .order("updated_at", { ascending: false });
    setSheetsLoading(false);
    if (error) {
      toast({ title: "Could not load lists", description: error.message, variant: "destructive" });
      return;
    }
    const list = (data || []).map(normaliseSheet);
    setSheets(list);
    setActiveId((prev) => (prev && list.some((s) => s.id === prev) ? prev : list[0]?.id ?? null));
  }, [toast]);

  useEffect(() => {
    if (session?.user && allowed) loadSheets();
  }, [session?.user, allowed, loadSheets]);

  // ── Saving ─────────────────────────────────────────────────────────────
  const flushSaves = useCallback(async () => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const batch = Array.from(pending.current.values());
    if (batch.length === 0) return;
    pending.current.clear();
    setSaveState("saving");
    let failed = false;
    for (const sheet of batch) {
      const { error } = await supabase
        .from("crm_sheets")
        .update({ name: sheet.name, columns: sheet.columns, rows: sheet.rows })
        .eq("id", sheet.id);
      if (error) {
        failed = true;
        // Keep the latest local copy queued so the next edit retries it.
        if (!pending.current.has(sheet.id)) pending.current.set(sheet.id, sheet);
        toast({ title: "Save failed", description: error.message, variant: "destructive" });
      }
    }
    setSaveState(failed ? "error" : pending.current.size ? "dirty" : "saved");
  }, [toast]);

  const scheduleSave = useCallback(() => {
    setSaveState("dirty");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      flushSaves();
    }, SAVE_DEBOUNCE_MS);
  }, [flushSaves]);

  /** Apply a local change to a sheet and queue it for saving. */
  const updateSheet = useCallback(
    (id: string, mutate: (s: Sheet) => Sheet) => {
      setSheets((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          const next = mutate(s);
          pending.current.set(id, next);
          return next;
        }),
      );
      scheduleSave();
    },
    [scheduleSave],
  );

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (pending.current.size > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // ── Sheet actions ──────────────────────────────────────────────────────
  const resetView = () => {
    setSearch("");
    setSearchCol(-1);
    setPage(0);
    setSelected(new Set());
    lastClicked.current = null;
    setRangeFrom("");
    setRangeTo("");
  };

  const createSheet = async (name: string, columns: string[], rows: string[][]): Promise<Sheet | null> => {
    if (!session?.user) return null;
    const { data, error } = await supabase
      .from("crm_sheets")
      .insert({ user_id: session.user.id, name, columns, rows })
      .select("id, name, columns, rows, updated_at")
      .single();
    if (error || !data) {
      toast({ title: "Could not create list", description: error?.message, variant: "destructive" });
      return null;
    }
    const sheet = normaliseSheet(data);
    setSheets((prev) => [sheet, ...prev]);
    setActiveId(sheet.id);
    resetView();
    toast({ title: "List created", description: `${rows.length} rows, ${columns.length} columns.` });
    return sheet;
  };

  const handleUpload = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.columns.length === 0) {
        toast({ title: "Empty file", description: "No columns were found in that CSV.", variant: "destructive" });
        return;
      }
      const name = file.name.replace(/\.[^.]+$/, "") || "Imported list";
      await createSheet(name, parsed.columns, parsed.rows);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    }
  };

  const switchSheet = async (id: string) => {
    await flushSaves();
    setActiveId(id);
    resetView();
  };

  const deleteSheet = async (id: string) => {
    pending.current.delete(id);
    const { error } = await supabase.from("crm_sheets").delete().eq("id", id);
    if (error) {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
      return;
    }
    setSheets((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      return next;
    });
  };

  const exportCsv = () => {
    if (!active) return;
    const blob = new Blob([toCsv(active.columns, active.rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active.name || "crm"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const signOut = async () => {
    await flushSaves();
    await supabase.auth.signOut({ scope: "local" });
  };

  // ── Table edits ────────────────────────────────────────────────────────
  const setCell = (rowIndex: number, colIndex: number, value: string) => {
    if (!active) return;
    updateSheet(active.id, (s) => {
      const rows = s.rows.slice();
      const row = rows[rowIndex].slice();
      row[colIndex] = value;
      rows[rowIndex] = row;
      return { ...s, rows };
    });
  };

  const renameColumn = (colIndex: number, value: string) => {
    if (!active) return;
    updateSheet(active.id, (s) => {
      const columns = s.columns.slice();
      columns[colIndex] = value;
      return { ...s, columns };
    });
  };

  const addRow = () => {
    if (!active) return;
    updateSheet(active.id, (s) => ({ ...s, rows: [...s.rows, s.columns.map(() => "")] }));
    setSearch("");
    setPage(Math.floor(active.rows.length / PAGE_SIZE));
  };

  const deleteRow = (rowIndex: number) => {
    if (!active) return;
    updateSheet(active.id, (s) => ({ ...s, rows: s.rows.filter((_, i) => i !== rowIndex) }));
    // Keep the selection pointing at the same rows after indexes shift down.
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i < rowIndex) next.add(i);
        else if (i > rowIndex) next.add(i - 1);
      });
      return next;
    });
    lastClicked.current = null;
  };

  const moveColumn = (from: number, to: number) => {
    if (!active || from === to || from < 0 || to < 0) return;
    if (from >= active.columns.length || to >= active.columns.length) return;
    const reorder = <T,>(arr: T[]): T[] => {
      const next = arr.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    };
    updateSheet(active.id, (s) => ({
      ...s,
      columns: reorder(s.columns),
      rows: s.rows.map((r) => reorder(r)),
    }));
    // Follow the column being searched so the filter keeps meaning the same thing.
    setSearchCol((sc) => {
      if (sc < 0) return sc;
      if (sc === from) return to;
      if (from < sc && sc <= to) return sc - 1;
      if (to <= sc && sc < from) return sc + 1;
      return sc;
    });
  };

  // ── Row selection ──────────────────────────────────────────────────────
  const toggleRow = (rowIndex: number, shiftKey: boolean, visibleOrder: number[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = lastClicked.current;
      if (shiftKey && anchor !== null && anchor !== rowIndex) {
        // Select every visible row between the anchor and this one, in display order.
        const a = visibleOrder.indexOf(anchor);
        const b = visibleOrder.indexOf(rowIndex);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(visibleOrder[i]);
          return next;
        }
      }
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
    lastClicked.current = rowIndex;
  };

  const setManySelected = (indexes: number[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      indexes.forEach((i) => (on ? next.add(i) : next.delete(i)));
      return next;
    });
  };

  const clearSelection = () => {
    setSelected(new Set());
    lastClicked.current = null;
  };

  /** Select rows by 1-based row number, e.g. 1 to 80. */
  const selectRange = () => {
    if (!active) return;
    const from = parseInt(rangeFrom, 10);
    const to = parseInt(rangeTo, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const lo = Math.max(1, Math.min(from, to));
    const hi = Math.min(active.rows.length, Math.max(from, to));
    if (lo > hi) return;
    const indexes: number[] = [];
    for (let n = lo; n <= hi; n++) indexes.push(n - 1);
    setManySelected(indexes, true);
  };

  const deleteSelectedRows = () => {
    if (!active || selected.size === 0) return;
    updateSheet(active.id, (s) => ({ ...s, rows: s.rows.filter((_, i) => !selected.has(i)) }));
    clearSelection();
  };

  /** Move (or copy) the selected rows into a brand-new list with the same columns. */
  const splitSelectedRows = async () => {
    if (!active || !split || selected.size === 0) return;
    const source = active;
    const picked = Array.from(selected).sort((a, b) => a - b);
    const rows = picked.map((i) => source.rows[i].slice());
    const name = split.name.trim() || `${source.name} (part)`;
    setSplitBusy(true);
    const created = await createSheet(name, source.columns.slice(), rows);
    setSplitBusy(false);
    if (!created) return;
    if (split.mode === "move") {
      updateSheet(source.id, (s) => ({ ...s, rows: s.rows.filter((_, i) => !selected.has(i)) }));
    }
    setSplit(null);
  };

  const addColumn = () => {
    if (!active) return;
    const name = newColumnName.trim() || `Column ${active.columns.length + 1}`;
    updateSheet(active.id, (s) => ({
      ...s,
      columns: [...s.columns, name],
      rows: s.rows.map((r) => [...r, ""]),
    }));
    setNewColumnName("");
    setAddColumnOpen(false);
  };

  const deleteColumn = (colIndex: number) => {
    if (!active) return;
    updateSheet(active.id, (s) => ({
      ...s,
      columns: s.columns.filter((_, i) => i !== colIndex),
      rows: s.rows.map((r) => r.filter((_, i) => i !== colIndex)),
    }));
    setSearchCol((sc) => (sc === colIndex ? -1 : sc > colIndex ? sc - 1 : sc));
  };

  // ── Derived view ───────────────────────────────────────────────────────
  const visibleIndexes = useMemo(() => {
    if (!active) return [] as number[];
    // Every word typed must appear somewhere in the row (or in the chosen column).
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = active.rows.map((_, i) => i);
    if (words.length === 0) return all;
    const scoped = searchCol >= 0 && searchCol < active.columns.length ? searchCol : -1;
    return all.filter((i) => {
      const row = active.rows[i];
      const haystack = scoped === -1 ? row.join(" \u0000 ").toLowerCase() : (row[scoped] ?? "").toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [active, search, searchCol]);

  const pageCount = Math.max(1, Math.ceil(visibleIndexes.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageIndexes = visibleIndexes.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const visibleSelectedCount = useMemo(
    () => visibleIndexes.reduce((n, i) => n + (selected.has(i) ? 1 : 0), 0),
    [visibleIndexes, selected],
  );
  const allVisibleSelected = visibleIndexes.length > 0 && visibleSelectedCount === visibleIndexes.length;
  const pageAllSelected = pageIndexes.length > 0 && pageIndexes.every((i) => selected.has(i));

  /* ───────────────────────────── render ───────────────────────────── */

  if (!sessionReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!session) return <CrmLogin />;

  if (!allowed) {
    return (
      <div className="flex min-h-screen flex-col bg-muted/30">
        <header className="border-b border-border/40 bg-white px-6 py-3">
          <img src={logo} alt="Greencaller" className="h-10 w-auto" />
        </header>
        <main className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md rounded-lg border border-border/60 bg-white p-8 text-center shadow-sm">
            <h1 className="mb-2 text-xl font-semibold">This account can&apos;t open the CRM</h1>
            <p className="mb-6 text-sm text-muted-foreground">
              You&apos;re signed in as {session.user.email}. Only the CRM owner account has access.
            </p>
            <Button onClick={signOut} variant="outline">
              <LogOut className="mr-2 h-4 w-4" /> Sign out and switch account
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const saveLabel: Record<SaveState, string> = {
    saved: "All changes saved",
    dirty: "Unsaved changes…",
    saving: "Saving…",
    error: "Save failed. It will retry on your next edit.",
  };

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border/40 bg-white px-6 py-3">
        <div className="flex items-center gap-4">
          <img src={logo} alt="Greencaller" className="h-9 w-auto" />
          <Badge variant="secondary" className="gap-1 font-normal">
            <Table2 className="h-3 w-3" /> CRM
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "hidden text-xs sm:inline",
              saveState === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {saveLabel[saveState]}
          </span>
          <span className="hidden text-sm text-muted-foreground md:inline">{session.user.email}</span>
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="mr-2 h-4 w-4" /> Sign out
          </Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-4 p-4 md:flex-row md:p-6">
        {/* Sheet list */}
        <aside className="w-full shrink-0 md:w-64">
          <div className="rounded-lg border border-border/60 bg-white p-3 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Lists</h2>
              <span className="text-xs text-muted-foreground">{sheets.length}</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleUpload(f);
                e.target.value = "";
              }}
            />
            <div className="mb-3 grid grid-cols-2 gap-2">
              <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="mr-1.5 h-4 w-4" /> Upload CSV
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => createSheet("New list", DEFAULT_COLUMNS, [DEFAULT_COLUMNS.map(() => "")])}
              >
                <Plus className="mr-1.5 h-4 w-4" /> Blank
              </Button>
            </div>
            {sheetsLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : sheets.length === 0 ? (
              <p className="px-1 py-4 text-xs text-muted-foreground">
                No lists yet. Upload a CSV export of your spreadsheet to get started.
              </p>
            ) : (
              <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
                {sheets.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => switchSheet(s.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                        s.id === activeId ? "bg-primary/10 text-primary" : "hover:bg-muted",
                      )}
                    >
                      <FileSpreadsheet className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate">{s.name || "Untitled list"}</span>
                      <span className="text-xs text-muted-foreground">{s.rows.length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Editor */}
        <main className="flex min-w-0 flex-1 flex-col">
          {!active ? (
            <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-white/60 p-12 text-center">
              <FileSpreadsheet className="mb-4 h-10 w-10 text-muted-foreground" />
              <h2 className="mb-1 text-lg font-semibold">Upload a client list</h2>
              <p className="mb-6 max-w-sm text-sm text-muted-foreground">
                Export your spreadsheet as CSV and upload it here. You can then edit every cell, add rows and
                columns, and everything saves automatically.
              </p>
              <Button onClick={() => fileInputRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" /> Upload CSV
              </Button>
            </div>
          ) : (
            <div className="flex flex-1 flex-col rounded-lg border border-border/60 bg-white shadow-sm">
              {/* Toolbar */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border/60 p-3">
                <Input
                  value={active.name}
                  onChange={(e) => updateSheet(active.id, (s) => ({ ...s, name: e.target.value }))}
                  className="h-9 w-56 font-medium"
                  aria-label="List name"
                />
                <div className="flex items-center overflow-hidden rounded-md border border-input bg-white focus-within:ring-1 focus-within:ring-ring">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <input
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setPage(0);
                      }}
                      placeholder={searchCol === -1 ? "Search all columns…" : `Search ${active.columns[searchCol] || "column"}…`}
                      className="h-9 w-52 bg-transparent pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground"
                      aria-label="Search rows"
                    />
                  </div>
                  <select
                    value={searchCol}
                    onChange={(e) => {
                      setSearchCol(Number(e.target.value));
                      setPage(0);
                    }}
                    className="h-9 max-w-[140px] cursor-pointer border-l border-input bg-muted/40 px-2 text-xs text-muted-foreground outline-none hover:bg-muted"
                    aria-label="Column to search in"
                    title="Which column to search"
                  >
                    <option value={-1}>All columns</option>
                    {active.columns.map((col, c) => (
                      <option key={c} value={c}>
                        {col || `Column ${c + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="text-xs text-muted-foreground">
                  {visibleIndexes.length === active.rows.length
                    ? `${active.rows.length} rows`
                    : `${visibleIndexes.length} of ${active.rows.length} rows`}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={addRow}>
                    <Plus className="mr-1.5 h-4 w-4" /> Row
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setAddColumnOpen(true)}>
                    <Columns3 className="mr-1.5 h-4 w-4" /> Column
                  </Button>
                  <Button size="sm" variant="outline" onClick={exportCsv}>
                    <Download className="mr-1.5 h-4 w-4" /> Export
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirm({ kind: "sheet", id: active.id, label: active.name })}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" /> Delete list
                  </Button>
                </div>
              </div>

              {/* Selection bar */}
              <div
                className={cn(
                  "flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-xs",
                  selected.size > 0 ? "bg-primary/5" : "bg-muted/20",
                )}
              >
                <ListChecks className="h-4 w-4 text-muted-foreground" />
                {selected.size > 0 ? (
                  <span className="font-medium text-foreground">
                    {selected.size} row{selected.size === 1 ? "" : "s"} selected
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Tick rows to select them. Shift-click selects a range.
                  </span>
                )}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    selectRange();
                  }}
                  className="flex items-center gap-1 text-muted-foreground"
                >
                  <span className="ml-2">Rows</span>
                  <input
                    value={rangeFrom}
                    onChange={(e) => setRangeFrom(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    placeholder="1"
                    className="h-7 w-14 rounded border border-input bg-white px-1.5 text-center text-xs outline-none focus:ring-1 focus:ring-ring"
                    aria-label="Select from row number"
                  />
                  <span>to</span>
                  <input
                    value={rangeTo}
                    onChange={(e) => setRangeTo(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    placeholder={String(Math.min(80, active.rows.length) || 1)}
                    className="h-7 w-14 rounded border border-input bg-white px-1.5 text-center text-xs outline-none focus:ring-1 focus:ring-ring"
                    aria-label="Select to row number"
                  />
                  <Button type="submit" size="sm" variant="outline" className="h-7 px-2 text-xs">
                    Select
                  </Button>
                </form>

                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setManySelected(visibleIndexes, !allVisibleSelected)}
                  disabled={visibleIndexes.length === 0}
                >
                  {allVisibleSelected ? "Unselect all" : search ? `Select all ${visibleIndexes.length} matching` : "Select all"}
                </Button>

                {selected.size > 0 && (
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setSplit({ mode: "move", name: `${active.name} – part` })}
                    >
                      <Scissors className="mr-1.5 h-3.5 w-3.5" /> Move to new list
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setSplit({ mode: "copy", name: `${active.name} – copy` })}
                    >
                      <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy to new list
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2.5 text-xs text-destructive hover:text-destructive"
                      onClick={() => setConfirm({ kind: "rows", count: selected.size })}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={clearSelection}>
                      <X className="mr-1 h-3.5 w-3.5" /> Clear
                    </Button>
                  </div>
                )}
              </div>

              {/* Grid */}
              <div className="flex-1 overflow-auto">
                <table className="w-max min-w-full border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur">
                    <tr>
                      <th className="w-9 border-b border-r border-border/60 p-0 text-center">
                        <div className="flex h-9 items-center justify-center">
                          <Checkbox
                            checked={pageAllSelected ? true : pageIndexes.some((i) => selected.has(i)) ? "indeterminate" : false}
                            onCheckedChange={() => setManySelected(pageIndexes, !pageAllSelected)}
                            aria-label="Select all rows on this page"
                            title="Select all rows on this page"
                            disabled={pageIndexes.length === 0}
                          />
                        </div>
                      </th>
                      <th className="w-10 border-b border-r border-border/60 px-2 py-1.5 text-right text-xs font-normal text-muted-foreground">
                        #
                      </th>
                      {active.columns.map((col, c) => (
                        <th
                          key={c}
                          onDragOver={(e) => {
                            if (dragCol === null) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            if (overCol !== c) setOverCol(c);
                          }}
                          onDragLeave={() => {
                            if (overCol === c) setOverCol(null);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragCol !== null) moveColumn(dragCol, c);
                            setDragCol(null);
                            setOverCol(null);
                          }}
                          className={cn(
                            "group min-w-[180px] border-b border-r border-border/60 p-0 text-left transition-colors",
                            dragCol === c && "opacity-50",
                            overCol === c && dragCol !== null && dragCol !== c && "bg-primary/10",
                            overCol === c && dragCol !== null && dragCol > c && "shadow-[inset_3px_0_0_0_hsl(var(--primary))]",
                            overCol === c && dragCol !== null && dragCol < c && "shadow-[inset_-3px_0_0_0_hsl(var(--primary))]",
                          )}
                        >
                          <div className="flex items-center">
                            <span
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", String(c));
                                setDragCol(c);
                              }}
                              onDragEnd={() => {
                                setDragCol(null);
                                setOverCol(null);
                              }}
                              title="Drag to reorder column"
                              className="flex h-9 w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
                            >
                              <GripVertical className="h-3.5 w-3.5" />
                            </span>
                            <input
                              value={col}
                              onChange={(e) => renameColumn(c, e.target.value)}
                              className="h-9 w-full min-w-0 bg-transparent px-1 text-xs font-semibold uppercase tracking-wide text-foreground outline-none focus:bg-white"
                              aria-label={`Column ${c + 1} name`}
                            />
                            <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                              <button
                                type="button"
                                title="Move column left"
                                disabled={c === 0}
                                onClick={() => moveColumn(c, c - 1)}
                                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                              >
                                <ChevronLeft className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                title="Move column right"
                                disabled={c === active.columns.length - 1}
                                onClick={() => moveColumn(c, c + 1)}
                                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                              >
                                <ChevronRight className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                title="Delete column"
                                onClick={() => setConfirm({ kind: "column", index: c, label: col })}
                                className="mr-1 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </th>
                      ))}
                      <th className="w-10 border-b border-border/60" />
                    </tr>
                  </thead>
                  <tbody>
                    {pageIndexes.length === 0 ? (
                      <tr>
                        <td
                          colSpan={active.columns.length + 3}
                          className="px-4 py-10 text-center text-sm text-muted-foreground"
                        >
                          {search ? "No rows match your search." : "No rows yet. Add one with the Row button."}
                        </td>
                      </tr>
                    ) : (
                      pageIndexes.map((r) => (
                        <tr
                          key={r}
                          className={cn("group hover:bg-muted/30", selected.has(r) && "bg-primary/5 hover:bg-primary/10")}
                        >
                          <td
                            className="cursor-pointer select-none border-b border-r border-border/60 p-0 text-center"
                            onClick={(e) => {
                              // Whole cell is a click target so the user can run down the column quickly.
                              e.preventDefault();
                              toggleRow(r, e.shiftKey, visibleIndexes);
                            }}
                            onMouseDown={(e) => {
                              if (e.shiftKey) e.preventDefault(); // stop text selection on shift-click
                            }}
                          >
                            <div className="pointer-events-none flex h-9 items-center justify-center">
                              <Checkbox checked={selected.has(r)} tabIndex={-1} aria-label={`Select row ${r + 1}`} />
                            </div>
                          </td>
                          <td className="border-b border-r border-border/60 px-2 py-1 text-right text-xs text-muted-foreground">
                            {r + 1}
                          </td>
                          {active.columns.map((_, c) => (
                            <td key={c} className="border-b border-r border-border/60 p-0">
                              <input
                                value={active.rows[r][c] ?? ""}
                                onChange={(e) => setCell(r, c, e.target.value)}
                                className="h-9 w-full bg-transparent px-2 outline-none focus:bg-primary/5 focus:ring-1 focus:ring-inset focus:ring-primary"
                              />
                            </td>
                          ))}
                          <td className="border-b border-border/60 p-0 text-center">
                            <button
                              type="button"
                              title="Delete row"
                              onClick={() => deleteRow(r)}
                              className="rounded p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {pageCount > 1 && (
                <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
                  <span>
                    Page {safePage + 1} of {pageCount}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={safePage === 0}
                      onClick={() => setPage(safePage - 1)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={safePage >= pageCount - 1}
                      onClick={() => setPage(safePage + 1)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Add column dialog */}
      <Dialog open={addColumnOpen} onOpenChange={setAddColumnOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add a column</DialogTitle>
            <DialogDescription>It will be appended to the right of the table.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addColumn();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="new-column">Column name</Label>
              <Input
                id="new-column"
                autoFocus
                value={newColumnName}
                onChange={(e) => setNewColumnName(e.target.value)}
                placeholder="e.g. Last called"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddColumnOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Add column</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Move / copy selected rows into a new list */}
      <Dialog open={split !== null} onOpenChange={(open) => !open && !splitBusy && setSplit(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{split?.mode === "move" ? "Move rows to a new list" : "Copy rows to a new list"}</DialogTitle>
            <DialogDescription>
              {selected.size} selected row{selected.size === 1 ? "" : "s"} will{" "}
              {split?.mode === "move" ? "be moved out of this list and into" : "be copied into"} a new list with the
              same columns. It will appear in the Lists panel on the left.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              splitSelectedRows();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="split-name">New list name</Label>
              <Input
                id="split-name"
                autoFocus
                value={split?.name ?? ""}
                onChange={(e) => setSplit((s) => (s ? { ...s, name: e.target.value } : s))}
                placeholder="e.g. Batch 2"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSplit(null)} disabled={splitBusy}>
                Cancel
              </Button>
              <Button type="submit" disabled={splitBusy}>
                {splitBusy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : split?.mode === "move" ? (
                  <Scissors className="mr-2 h-4 w-4" />
                ) : (
                  <Copy className="mr-2 h-4 w-4" />
                )}
                {split?.mode === "move" ? "Move rows" : "Copy rows"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmations */}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "sheet"
                ? "Delete this list?"
                : confirm?.kind === "rows"
                  ? `Delete ${confirm.count} selected row${confirm.count === 1 ? "" : "s"}?`
                  : "Delete this column?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "sheet"
                ? `"${confirm.label || "Untitled list"}" and all of its rows will be permanently removed.`
                : confirm?.kind === "rows"
                  ? "The selected rows will be removed from this list. This can't be undone."
                  : `"${confirm?.label || "Column"}" and its values in every row will be removed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirm?.kind === "sheet") deleteSheet(confirm.id);
                if (confirm?.kind === "column") deleteColumn(confirm.index);
                if (confirm?.kind === "rows") deleteSelectedRows();
                setConfirm(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Crm;
