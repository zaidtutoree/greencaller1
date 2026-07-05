import { useEffect, useRef, useState, useCallback } from "react";
import { Mic, Volume2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getSelectedMicId,
  getSelectedSpeakerId,
  setSelectedMicId,
  setSelectedSpeakerId,
} from "@/utils/audioDevices";

const NUM_BARS = 8;
const DEFAULT_VALUE = "default";

export const AudioSettings = () => {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>(getSelectedMicId() || DEFAULT_VALUE);
  const [speakerId, setSpeakerId] = useState<string>(getSelectedSpeakerId() || DEFAULT_VALUE);
  const [level, setLevel] = useState(0); // 0..1 mic volume
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [supportsOutput, setSupportsOutput] = useState(true);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputs(devices.filter((d) => d.kind === "audioinput"));
      setOutputs(devices.filter((d) => d.kind === "audiooutput"));
    } catch (e) {
      console.warn("enumerateDevices failed:", e);
    }
  }, []);

  // Start (or restart) the live mic meter for the chosen input device.
  const startMeter = useCallback(async (deviceId: string) => {
    // Tear down any previous stream/context first.
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (ctxRef.current) {
      ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }

    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId && deviceId !== DEFAULT_VALUE ? { deviceId: { exact: deviceId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      setPermissionDenied(false);

      // Device labels are only populated after permission is granted.
      loadDevices();

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        // RMS around the 128 midpoint → 0..1
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        // Scale up a bit so normal speech fills the meter.
        setLevel(Math.min(1, rms * 2.2));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      console.warn("Mic test failed:", e);
      setPermissionDenied(true);
      setLevel(0);
    }
  }, [loadDevices]);

  // Detect whether output device selection is supported (Chromium setSinkId).
  useEffect(() => {
    setSupportsOutput(typeof (HTMLMediaElement.prototype as any).setSinkId === "function");
  }, []);

  // Start the meter when the panel opens; clean up on unmount.
  useEffect(() => {
    startMeter(getSelectedMicId() || DEFAULT_VALUE);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (ctxRef.current) ctxRef.current.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMicChange = (value: string) => {
    setMicId(value);
    setSelectedMicId(value === DEFAULT_VALUE ? "" : value);
    startMeter(value);
  };

  const handleSpeakerChange = (value: string) => {
    setSpeakerId(value);
    setSelectedSpeakerId(value === DEFAULT_VALUE ? "" : value);
  };

  const activeBars = Math.round(level * NUM_BARS);

  return (
    <div className="space-y-8">
      {/* Input */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Mic className="w-4 h-4 text-primary" />
          <h3 className="font-semibold">Input</h3>
        </div>

        <div className="space-y-2">
          <Label>Device</Label>
          <Select value={micId} onValueChange={handleMicChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select a microphone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_VALUE}>System default</SelectItem>
              {inputs.map((d, i) => (
                <SelectItem key={d.deviceId || i} value={d.deviceId || `mic-${i}`}>
                  {d.label || `Microphone ${i + 1}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-muted-foreground">Test microphone</Label>
          <div className="flex items-center gap-1.5">
            {Array.from({ length: NUM_BARS }).map((_, i) => (
              <div
                key={i}
                className={`h-6 w-3 rounded-full transition-colors duration-75 ${
                  i < activeBars ? "bg-green-500" : "bg-muted"
                }`}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {permissionDenied
              ? "Microphone access is blocked. Allow it in your browser to test."
              : "Speak — the bars light up green with your voice."}
          </p>
        </div>
      </section>

      {/* Output */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Volume2 className="w-4 h-4 text-primary" />
          <h3 className="font-semibold">Output</h3>
        </div>

        <div className="space-y-2">
          <Label>Device</Label>
          <Select value={speakerId} onValueChange={handleSpeakerChange} disabled={!supportsOutput}>
            <SelectTrigger>
              <SelectValue placeholder="Select a speaker" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_VALUE}>System default</SelectItem>
              {outputs.map((d, i) => (
                <SelectItem key={d.deviceId || i} value={d.deviceId || `spk-${i}`}>
                  {d.label || `Speaker ${i + 1}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!supportsOutput && (
            <p className="text-xs text-muted-foreground">
              Choosing an output device isn't supported in this browser; the system default is used.
            </p>
          )}
        </div>
      </section>
    </div>
  );
};
