import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Bot, Plus, Loader2, Trash2, Pencil, Phone, User as UserIcon, Sparkles } from "lucide-react";
import { VoicePicker } from "@/components/admin/VoicePicker";

interface Assistant {
  id: string;
  telnyx_assistant_id: string | null;
  telnyx_phone_number: string | null;
  name: string;
  description: string | null;
  model: string;
  character_prompt: string | null;
  greeting: string | null;
  voice: string;
  collect_fields: string[];
  assigned_user_id: string | null;
  is_active: boolean;
  profiles?: { id: string; full_name: string; email: string } | null;
}

interface Voice { id: string; name: string; provider: string; gender: string; language: string; }
interface ModelOpt { id: string; label: string; }
interface UserOpt { id: string; full_name: string; email: string; account_type: string; }

const COLLECT_OPTIONS: { key: string; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone number" },
  { key: "company", label: "Company" },
  { key: "reason", label: "Reason for call" },
  { key: "address", label: "Address" },
  { key: "appointment", label: "Appointment time" },
  { key: "budget", label: "Budget" },
];

const emptyForm = {
  id: null as string | null,
  name: "",
  description: "",
  model: "anthropic/claude-haiku-4-5",
  voice: "Telnyx.KokoroTTS.af_heart",
  character_prompt: "",
  greeting: "",
  collect_fields: [] as string[],
};

export const AILab = () => {
  const { toast } = useToast();
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [availableNumbers, setAvailableNumbers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const token = () => localStorage.getItem("admin_session_token") || "";

  const call = async (body: any) => {
    const { data, error } = await supabase.functions.invoke("admin-ai-assistant", {
      body,
      headers: { "x-admin-token": token() },
    });
    if (error) throw new Error(error.message);
    if (data?.error) throw new Error(data.error);
    return data;
  };

  const load = async () => {
    try {
      const [a, v, m, u, n] = await Promise.all([
        call({ action: "list" }),
        call({ action: "voices" }),
        call({ action: "models" }),
        call({ action: "users" }),
        call({ action: "numbers" }),
      ]);
      setAssistants(a.assistants || []);
      setVoices(v.voices || []);
      setModels(m.models || []);
      setUsers(u.users || []);
      setAvailableNumbers((n.numbers || []).map((x: any) => x.phone_number));
    } catch (e: any) {
      toast({ title: "Error", description: e.message || "Failed to load AI Lab", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => { setForm(emptyForm); setDialogOpen(true); };
  const openEdit = (a: Assistant) => {
    setForm({
      id: a.id,
      name: a.name,
      description: a.description || "",
      model: a.model,
      voice: a.voice,
      character_prompt: a.character_prompt || "",
      greeting: a.greeting || "",
      collect_fields: Array.isArray(a.collect_fields) ? a.collect_fields : [],
    });
    setDialogOpen(true);
  };

  const toggleField = (key: string) => {
    setForm((f) => ({
      ...f,
      collect_fields: f.collect_fields.includes(key)
        ? f.collect_fields.filter((k) => k !== key)
        : [...f.collect_fields, key],
    }));
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await call({
        action: form.id ? "update" : "create",
        id: form.id || undefined,
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        model: form.model,
        voice: form.voice,
        character_prompt: form.character_prompt,
        greeting: form.greeting.trim() || undefined,
        collect_fields: form.collect_fields,
      });
      toast({ title: form.id ? "Assistant updated" : "Assistant created" });
      setDialogOpen(false);
      load();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const assignUser = async (assistant: Assistant, userId: string) => {
    try {
      await call({ action: "assign-user", id: assistant.id, user_id: userId || null });
      toast({ title: userId ? "Assigned to user" : "Unassigned" });
      load();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const setNumber = async (assistant: Assistant, phone: string) => {
    try {
      if (phone === "none") {
        await call({ action: "unassign-number", id: assistant.id });
        toast({ title: "Number removed" });
      } else {
        await call({ action: "assign-number", id: assistant.id, phone_number: phone });
        toast({ title: "Number assigned", description: "Calls to this number are now answered by the AI." });
      }
      load();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const remove = async (a: Assistant) => {
    if (!confirm(`Delete assistant "${a.name}"? This also removes it from Telnyx.`)) return;
    try {
      await call({ action: "delete", id: a.id });
      toast({ title: "Assistant deleted" });
      load();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const voiceLabel = useMemo(() => {
    const map = new Map(voices.map((v) => [v.id, v]));
    return (id: string) => {
      const v = map.get(id);
      return v ? `${v.name} (${v.gender}, ${v.language})` : id;
    };
  }, [voices]);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="w-6 h-6 text-primary" /> AI Lab
          </h1>
          <p className="text-muted-foreground text-sm">
            Create AI phone assistants, choose their voice and character, and pick what they collect. Assign one to a user to give them their own AI receptionist.
          </p>
        </div>
        <Button onClick={openCreate} className="gap-1.5"><Plus className="w-4 h-4" /> New Assistant</Button>
      </div>

      {assistants.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Sparkles className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="font-medium mb-1">No AI assistants yet</h3>
            <p className="text-sm text-muted-foreground mb-4">Create your first AI assistant to get started.</p>
            <Button onClick={openCreate} className="gap-1.5"><Plus className="w-4 h-4" /> New Assistant</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {assistants.map((a) => (
            <Card key={a.id}>
              <CardContent className="pt-6 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold truncate">{a.name}</h3>
                      {!a.is_active && <Badge variant="secondary">Inactive</Badge>}
                    </div>
                    {a.description && <p className="text-xs text-muted-foreground truncate">{a.description}</p>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(a)} title="Edit"><Pencil className="w-4 h-4" /></Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => remove(a)} title="Delete"><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 text-xs">
                  <Badge variant="outline" className="gap-1"><Sparkles className="w-3 h-3" />{voiceLabel(a.voice)}</Badge>
                  <Badge variant="outline">{models.find((m) => m.id === a.model)?.label || a.model}</Badge>
                  {a.telnyx_phone_number && <Badge variant="outline" className="gap-1"><Phone className="w-3 h-3" />{a.telnyx_phone_number}</Badge>}
                </div>

                {a.collect_fields?.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    Collects: {a.collect_fields.map((f) => COLLECT_OPTIONS.find((o) => o.key === f)?.label || f).join(", ")}
                  </div>
                )}

                <div className="flex items-center gap-2 pt-2 border-t">
                  <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
                  <Select value={a.telnyx_phone_number || "none"} onValueChange={(v) => setNumber(a, v)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Assign a number" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No number</SelectItem>
                      {a.telnyx_phone_number && (
                        <SelectItem value={a.telnyx_phone_number}>{a.telnyx_phone_number} (current)</SelectItem>
                      )}
                      {availableNumbers
                        .filter((num) => num !== a.telnyx_phone_number)
                        .map((num) => <SelectItem key={num} value={num}>{num}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-2">
                  <UserIcon className="w-4 h-4 text-muted-foreground shrink-0" />
                  <Select value={a.assigned_user_id || "none"} onValueChange={(v) => assignUser(a, v === "none" ? "" : v)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Assign to user" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {users.map((u) => (
                        <SelectItem key={u.id} value={u.id}>{u.full_name || u.email} ({u.account_type})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Bot className="w-5 h-5 text-primary" />{form.id ? "Edit Assistant" : "New Assistant"}</DialogTitle>
            <DialogDescription>Configure the assistant's voice, character, and what it collects from callers.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Dental Clinic Receptionist" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Model</Label>
                <Select value={form.model} onValueChange={(v) => setForm({ ...form, model: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {models.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Voice</Label>
                <VoicePicker voices={voices} value={form.voice} onChange={(v) => setForm({ ...form, voice: v })} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Character / instructions</Label>
              <Textarea
                value={form.character_prompt}
                onChange={(e) => setForm({ ...form, character_prompt: e.target.value })}
                placeholder="Describe how the assistant should behave, its tone, and its purpose. e.g. 'You are a warm, professional receptionist for a dental clinic. Help callers book appointments and answer questions about opening hours.'"
                className="min-h-[110px]"
              />
            </div>

            <div className="space-y-2">
              <Label>Greeting (first thing the caller hears)</Label>
              <Input value={form.greeting} onChange={(e) => setForm({ ...form, greeting: e.target.value })} placeholder="Hello, thanks for calling Bright Smiles Dental. How can I help?" />
            </div>

            <div className="space-y-2">
              <Label>Information to collect</Label>
              <div className="grid grid-cols-2 gap-2">
                {COLLECT_OPTIONS.map((o) => {
                  const on = form.collect_fields.includes(o.key);
                  return (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => toggleField(o.key)}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-left transition-colors ${on ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}
                    >
                      <span className={`w-4 h-4 rounded border flex items-center justify-center ${on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}`}>
                        {on && <span className="text-[10px]">✓</span>}
                      </span>
                      {o.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">Selected details are added to the assistant's instructions so it asks for and confirms them during the call.</p>
            </div>

            <div className="space-y-2">
              <Label>Description <span className="text-muted-foreground font-normal">(internal, optional)</span></Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Notes for admins" />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
              {form.id ? "Save changes" : "Create assistant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AILab;
