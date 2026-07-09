import { useMemo, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Check, ChevronsUpDown, Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Voice { id: string; name: string; provider: string; gender: string; language: string; }

interface VoicePickerProps {
  voices: Voice[];
  value: string;
  onChange: (id: string) => void;
}

// Map a BCP-47 language tag (e.g. "en-US") to a country name for search/display.
const countryName = (lang: string): string => {
  const region = lang?.split("-")[1];
  if (!region) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(region) || region;
  } catch {
    return region;
  }
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export const VoicePicker = ({ voices, value, onChange }: VoicePickerProps) => {
  const [open, setOpen] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const enriched = useMemo(
    () => voices.map((v) => ({ ...v, country: countryName(v.language) })),
    [voices],
  );
  const selected = enriched.find((v) => v.id === value);

  const stopAudio = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setPreviewing(null);
  };

  const preview = async (voiceId: string) => {
    if (previewing === voiceId) { stopAudio(); return; }
    stopAudio();
    setPreviewing(voiceId);
    try {
      const token = localStorage.getItem("admin_session_token") || "";
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-voice-preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "x-admin-token": token,
        },
        body: JSON.stringify({ voice: voiceId }),
      });
      if (!res.ok) throw new Error("preview failed");
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      audio.onended = () => setPreviewing((p) => (p === voiceId ? null : p));
      await audio.play();
    } catch {
      setPreviewing(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) stopAudio(); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
          <span className="truncate">
            {selected ? `${selected.name} · ${selected.gender} · ${selected.country || selected.language}` : "Select a voice"}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command
          filter={(itemValue, search) => (itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder="Search name, country, or 'male'/'female'…" />
          <CommandList className="max-h-72">
            <CommandEmpty>No voice found.</CommandEmpty>
            <CommandGroup>
              {enriched.map((v) => (
                <CommandItem
                  key={v.id}
                  value={`${v.name} ${v.gender} ${v.provider} ${v.language} ${v.country}`}
                  onSelect={() => { onChange(v.id); setOpen(false); stopAudio(); }}
                  className="flex items-center gap-2"
                >
                  <Check className={cn("h-4 w-4 shrink-0", value === v.id ? "opacity-100" : "opacity-0")} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{v.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {v.gender} · {v.country || v.language} · {v.provider}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); preview(v.id); }}
                    className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted shrink-0"
                    title="Preview voice"
                  >
                    {previewing === v.id
                      ? <Square className="h-3.5 w-3.5" />
                      : <Play className="h-3.5 w-3.5" />}
                  </button>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
