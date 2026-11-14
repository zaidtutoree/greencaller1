import { useState, useEffect, useRef, useCallback } from "react";
import { Play, Square, Upload, Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  RINGTONE_PRESETS,
  getRingtonePreference,
  setRingtonePreference,
  getCustomRingtone,
  getCustomRingtoneName,
  setCustomRingtone,
  removeCustomRingtone,
  previewRingtone,
} from "@/utils/ringtone";

export const RingtoneSettings = () => {
  const { toast } = useToast();
  const [selectedRingtone, setSelectedRingtone] = useState(getRingtonePreference());
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const stopPreviewRef = useRef<(() => void) | null>(null);
  const ringtoneFileInputRef = useRef<HTMLInputElement>(null);
  const [customRingtoneName, setCustomRingtoneName] = useState<string | null>(getCustomRingtoneName());
  const hasCustomRingtone = !!getCustomRingtone();

  const handleSelectRingtone = useCallback((id: string) => {
    setRingtonePreference(id);
    setSelectedRingtone(id);
  }, []);

  const handlePreview = useCallback((id: string) => {
    if (stopPreviewRef.current) {
      stopPreviewRef.current();
      stopPreviewRef.current = null;
    }

    if (previewingId === id) {
      setPreviewingId(null);
      return;
    }

    setPreviewingId(id);
    const stop = previewRingtone(id);
    stopPreviewRef.current = () => {
      stop();
      setPreviewingId(null);
    };

    setTimeout(() => {
      if (stopPreviewRef.current) {
        stopPreviewRef.current = null;
        setPreviewingId(null);
      }
    }, 4000);
  }, [previewingId]);

  const handleRingtoneUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("audio/")) {
      toast({
        title: "Invalid file type",
        description: "Please upload an audio file (.mp3, .wav, .ogg).",
        variant: "destructive",
      });
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Please upload an audio file smaller than 2MB.",
        variant: "destructive",
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setCustomRingtone(dataUrl, file.name);
      setCustomRingtoneName(file.name);
      handleSelectRingtone("custom");
      toast({
        title: "Ringtone uploaded",
        description: `"${file.name}" set as your ringtone.`,
      });
    };
    reader.readAsDataURL(file);

    if (ringtoneFileInputRef.current) {
      ringtoneFileInputRef.current.value = "";
    }
  }, [toast, handleSelectRingtone]);

  const handleRemoveCustom = useCallback(() => {
    removeCustomRingtone();
    setCustomRingtoneName(null);
    setSelectedRingtone("classic");
    toast({
      title: "Custom ringtone removed",
      description: "Switched back to the Default ringtone.",
    });
  }, [toast]);

  useEffect(() => {
    return () => {
      if (stopPreviewRef.current) {
        stopPreviewRef.current();
      }
    };
  }, []);

  const renderRow = (
    id: string,
    name: string,
    description: string,
    extraActions?: React.ReactNode,
  ) => (
    <div
      onClick={() => handleSelectRingtone(id)}
      className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
        selectedRingtone === id
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/50 hover:bg-muted/50"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
          selectedRingtone === id ? "border-primary" : "border-muted-foreground/40"
        }`}>
          {selectedRingtone === id && <Check className="w-3 h-3 text-primary" />}
        </div>
        <div>
          <p className="font-medium text-sm">{name}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            handlePreview(id);
          }}
          className="h-8 w-8 p-0"
        >
          {previewingId === id ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </Button>
        {extraActions}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose the ringtone you'll hear on incoming calls.
      </p>

      <div className="space-y-2">
        {RINGTONE_PRESETS.map((preset) => (
          <div key={preset.id}>{renderRow(preset.id, preset.name, preset.description)}</div>
        ))}

        {/* Custom Ringtone Option */}
        {hasCustomRingtone && customRingtoneName &&
          renderRow(
            "custom",
            "Custom",
            customRingtoneName,
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleRemoveCustom();
              }}
              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
            >
              <Trash2 className="w-4 h-4" />
            </Button>,
          )}
      </div>

      {/* Upload Custom Ringtone */}
      <div>
        <Button
          variant="outline"
          onClick={() => ringtoneFileInputRef.current?.click()}
          className="w-full"
        >
          <Upload className="w-4 h-4 mr-2" />
          Upload Custom Ringtone
        </Button>
        <input
          ref={ringtoneFileInputRef}
          type="file"
          accept="audio/wav,audio/mpeg,audio/ogg,audio/mp3,.wav,.mp3,.ogg"
          onChange={handleRingtoneUpload}
          className="hidden"
        />
        <p className="text-xs text-muted-foreground mt-2 text-center">
          Supports .mp3, .wav, .ogg (max 2MB)
        </p>
      </div>
    </div>
  );
};
