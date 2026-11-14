// Selected audio input/output device preferences.
// Kept intentionally isolated from the call code: applying a device is always
// wrapped in try/catch and no-ops when nothing is selected, so it can never
// break call setup. An empty string means "system default".
const MIC_KEY = "selectedMicId";
const SPEAKER_KEY = "selectedSpeakerId";

/** Fired (on window) whenever a selection changes, so live calls can re-apply. */
export const AUDIO_DEVICES_CHANGED = "audio-devices-changed";

export function getSelectedMicId(): string {
  return localStorage.getItem(MIC_KEY) || "";
}

export function getSelectedSpeakerId(): string {
  return localStorage.getItem(SPEAKER_KEY) || "";
}

export function setSelectedMicId(id: string): void {
  localStorage.setItem(MIC_KEY, id);
  try {
    window.dispatchEvent(new Event(AUDIO_DEVICES_CHANGED));
  } catch { /* SSR / no window */ }
}

export function setSelectedSpeakerId(id: string): void {
  localStorage.setItem(SPEAKER_KEY, id);
  try {
    window.dispatchEvent(new Event(AUDIO_DEVICES_CHANGED));
  } catch { /* no window */ }
}

/** Route an <audio> element to the selected output device (Chromium setSinkId). */
export async function applySelectedSpeaker(el: HTMLMediaElement | null): Promise<void> {
  if (!el) return;
  const id = getSelectedSpeakerId();
  if (!id) return; // system default
  try {
    const anyEl = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof anyEl.setSinkId === "function") {
      await anyEl.setSinkId(id);
    }
  } catch (e) {
    console.warn("Failed to apply selected speaker (setSinkId):", e);
  }
}

/** Point the Telnyx client at the selected microphone, if the SDK supports it. */
export async function applySelectedMic(client: any): Promise<void> {
  const id = getSelectedMicId();
  if (!id || !client) return; // system default
  try {
    if (typeof client.setAudioInDevice === "function") {
      await client.setAudioInDevice(id);
    }
  } catch (e) {
    console.warn("Failed to apply selected microphone (setAudioInDevice):", e);
  }
}
