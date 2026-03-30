import { useState, useRef, useEffect, useCallback } from "react";
import { TelnyxRTC } from "@telnyx/webrtc";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface TelnyxCallState {
  isActive: boolean;
  phoneNumber: string;
  callerName?: string;
  callerCompany?: string;
  duration: number;
  isMuted: boolean;
  isOnHold: boolean;
  isRecording: boolean;
  isPaused: boolean;
  callId: string | null;
  pstnCallControlId: string | null; // The PSTN leg's call control ID (used for recording)
}

interface TelnyxIncomingCallState {
  isIncoming: boolean;
  isDismissed: boolean;
  phoneNumber: string;
  callerName?: string;
  call: any | null;
}

interface UseTelnyxCallProps {
  userId?: string;
  assignedNumber?: string | null;
  enabled?: boolean;
}

export const useTelnyxCall = ({ userId, assignedNumber, enabled = true }: UseTelnyxCallProps) => {
  const { toast } = useToast();
  const clientRef = useRef<TelnyxRTC | null>(null);
  const activeCallRef = useRef<any>(null);
  const incomingCallRef = useRef<any>(null); // Track incoming call to prevent duplicate detection
  const credsRef = useRef<{ sipUsername: string; sipPassword: string; expiresAt?: string } | null>(null);
  const callIntervalRef = useRef<number | null>(null);
  const isInitializing = useRef(false);
  const retryCountRef = useRef(0);
  // Track when we're waiting for a bridged call (outbound call initiated via edge function)
  const awaitingBridgeRef = useRef<{ toNumber: string; fromNumber: string } | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  // Track call IDs that have been declined / sent to voicemail so the notification
  // handler doesn't re-trigger the incoming call modal when late callUpdate events arrive.
  const declinedCallIdsRef = useRef<Set<string>>(new Set());
  // Track declined caller phone numbers with timestamps.
  // The platform may send NEW SIP INVITEs (different call IDs) for the same caller
  // while the TeXML <Dial> timeout hasn't expired. Block by phone number for 65 seconds.
  const declinedCallersRef = useRef<Map<string, number>>(new Map());

  // Used to await Telnyx readiness (prevents "Client not ready" race conditions)
  const readyPromiseRef = useRef<Promise<void> | null>(null);
  const readyResolveRef = useRef<(() => void) | null>(null);

  const [isClientReady, setIsClientReady] = useState(false);
  const [isRegistrationStale, setIsRegistrationStale] = useState(false);
  const lastHeartbeatRef = useRef<number>(Date.now());
  const [callState, setCallState] = useState<TelnyxCallState>({
    isActive: false,
    phoneNumber: "",
    duration: 0,
    isMuted: false,
    isOnHold: false,
    isRecording: false,
    isPaused: false,
    callId: null,
    pstnCallControlId: null,
  });
  // Mirror callState in a ref so event handlers inside useEffect closures can read the latest value
  const callStateRef = useRef(callState);
  callStateRef.current = callState;

  const [incomingCall, setIncomingCall] = useState<TelnyxIncomingCallState>({
    isIncoming: false,
    isDismissed: false,
    phoneNumber: "",
    call: null,
  });

  // Try to discover the PSTN leg Call ID from Telnyx call objects.
  // For inbound calls, the WebRTC SDK call.id is usually a UUID (SIP leg) and NOT usable for recording APIs.
  // We need to find either:
  // 1. Call Control ID (v2:/v3: prefixed) - for outbound calls
  // 2. TeXML CallSid (UUID) - for inbound calls, passed via X-PSTN-Call-Sid header
  const extractPstnCallControlId = useCallback((call: any): string | null => {
    if (!call) return null;

    // Helper to check if a value looks like a valid Telnyx Call Control ID
    const isCallControlId = (val: unknown): val is string => {
      if (typeof val !== 'string' || !val) return false;
      return val.startsWith('v2:') || val.startsWith('v3:');
    };

    // Helper to check if a value looks like a valid UUID (TeXML CallSid)
    const isValidUUID = (val: unknown): val is string => {
      if (typeof val !== 'string' || !val) return false;
      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
    };

    // FIRST: Check custom SIP headers for PSTN Call-Sid (inbound calls)
    // This must come first because for inbound calls, call.callControlId is the WebRTC leg,
    // not the PSTN leg we need for recording
    const headerSources = [
      call.options?.customHeaders,
      call.options?.sipHeaders,
      call.options?.headers,
      call.customHeaders,
      call.sipHeaders,
    ];

    for (const headers of headerSources) {
      if (!Array.isArray(headers)) continue;
      for (const h of headers) {
        const name = (h?.name || h?.header || h?.Name || "").toString().toLowerCase();
        const value = (h?.value || h?.headerValue || h?.Value || "").toString();

        // Check for our custom X-PSTN-Call-Sid header (inbound TeXML calls)
        if (name.includes("x-pstn-call-sid") || name.includes("pstn-call-sid")) {
          if (value && (isValidUUID(value) || isCallControlId(value))) {
            console.log(`Extracted PSTN CallSid from SIP header ${name}:`, value);
            return value;
          }
        }

        // Also check for other call ID headers as fallback
        if (name.includes("pstn-call-control") ||
          name.includes("x-pstn-call-control-id") ||
          name.includes("x-telnyx-call-control-id") ||
          name.includes("callsid") ||
          name.includes("call-sid") ||
          name.includes("call_control")
        ) {
          if (value && value.length > 10) {
            console.log(`Extracted PSTN Call ID from SIP header ${name}:`, value);
            return value;
          }
        }
      }
    }

    // SECOND: Check for Call Control IDs on the call object (outbound calls)
    const candidates: unknown[] = [
      call.call_control_id,
      call.callControlId,
      call.call_control_id_legacy,
      call.options?.call_control_id,
      call.options?.callControlId,
      call.options?.call_control_id_legacy,
    ];

    for (const c of candidates) {
      if (isCallControlId(c)) return c;
    }

    return null;
  }, []);

  const storageKeyForUser = (uid: string) => `greencaller_telnyx_creds_v1:${uid}`;

  const readStoredCreds = useCallback((uid: string) => {
    try {
      const raw = window.localStorage.getItem(storageKeyForUser(uid));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { sipUsername?: string; sipPassword?: string; expiresAt?: string };
      if (!parsed?.sipUsername || !parsed?.sipPassword) return null;
      // Consider creds valid if they expire in >60s, or if expiry is absent.
      if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now() + 60_000) return null;
      return {
        sipUsername: parsed.sipUsername,
        sipPassword: parsed.sipPassword,
        expiresAt: parsed.expiresAt,
      };
    } catch {
      return null;
    }
  }, []);

  const writeStoredCreds = useCallback((uid: string, creds: { sipUsername: string; sipPassword: string; expiresAt?: string }) => {
    try {
      window.localStorage.setItem(storageKeyForUser(uid), JSON.stringify(creds));
    } catch {
      // ignore
    }
  }, []);

  // Load persisted credentials (prevents SIP username rotation on refresh / React remount / transient provider gating)
  useEffect(() => {
    if (!userId) return;
    if (credsRef.current?.sipUsername && credsRef.current?.sipPassword) return;
    const stored = readStoredCreds(userId);
    if (stored) {
      credsRef.current = stored;
    }
  }, [userId, readStoredCreds]);

  const startDurationTimer = useCallback(() => {
    if (callIntervalRef.current) {
      clearInterval(callIntervalRef.current);
    }
    callIntervalRef.current = window.setInterval(() => {
      setCallState((prev) => ({ ...prev, duration: prev.duration + 1 }));
    }, 1000);
  }, []);

  const stopDurationTimer = useCallback(() => {
    if (callIntervalRef.current) {
      clearInterval(callIntervalRef.current);
      callIntervalRef.current = null;
    }
  }, []);

  const resetCallState = useCallback(() => {
    stopDurationTimer();
    awaitingBridgeRef.current = null; // Clear any pending bridge
    setCallState({
      isActive: false,
      phoneNumber: "",
      duration: 0,
      isMuted: false,
      isOnHold: false,
      isRecording: false,
      isPaused: false,
      callId: null,
      pstnCallControlId: null,
    });
    activeCallRef.current = null;
  }, [stopDurationTimer]);

  // Initialize Telnyx WebRTC client
  useEffect(() => {
    // Create remote audio element for receiving audio
    if (!remoteAudioRef.current) {
      const audioEl = document.createElement('audio');
      audioEl.id = 'telnyx-remote-audio';
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
      remoteAudioRef.current = audioEl;
    }

    const initializeTelnyxClient = async () => {
      // Don't initialize if not enabled or no user
      if (!enabled || !userId) {
        console.log("Telnyx: Skipping initialization - enabled:", enabled, "userId:", userId);
        return;
      }

      if (isInitializing.current || clientRef.current) return;
      isInitializing.current = true;

      const failInit = (reason: string, err?: unknown) => {
        if (err) console.error(reason, err);
        else console.error(reason);

        setIsClientReady(false);
        // Null out ref BEFORE disconnecting so that the synchronous socket.close
        // event fired by disconnect() sees an orphaned client and is ignored.
        const oldClient = clientRef.current;
        clientRef.current = null;
        isInitializing.current = false;
        if (oldClient) {
          try { oldClient.disconnect(); } catch {}
        }

        // Unblock any makeCall waiting for readiness
        readyResolveRef.current?.();
        readyPromiseRef.current = null;
        readyResolveRef.current = null;

        const attempt = Math.min(retryCountRef.current + 1, 6);
        retryCountRef.current = attempt;
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);

        window.setTimeout(() => {
          initializeTelnyxClient();
        }, delayMs);
      };

      // Create/refresh the readiness promise for this init cycle
      readyPromiseRef.current = new Promise<void>((resolve) => {
        readyResolveRef.current = resolve;
      });

      try {
        let sipUsername: string | undefined;
        let sipPassword: string | undefined;

        // Reuse credentials during reconnects to avoid rotating SIP usernames mid-session.
        const cached = credsRef.current;
        const cachedValid = !!cached?.sipUsername && !!cached?.sipPassword && (!cached.expiresAt || Date.parse(cached.expiresAt) > Date.now() + 60_000);

        if (cachedValid) {
          sipUsername = cached!.sipUsername;
          sipPassword = cached!.sipPassword;
          console.log("Using cached Telnyx credentials:", sipUsername);
        } else {
          console.log("Fetching Telnyx credentials for user:", userId);
          const { data, error } = await supabase.functions.invoke("telnyx-generate-token", {
            body: { userId },
          });

          if (error) {
            failInit("Error getting Telnyx credentials:", error);
            return;
          }

          if (!data?.sipUsername || !data?.sipPassword) {
            failInit("Invalid Telnyx credentials received", data);
            return;
          }

          sipUsername = data.sipUsername;
          sipPassword = data.sipPassword;
          credsRef.current = { sipUsername, sipPassword, expiresAt: data.expiresAt };
        }

        console.log("Initializing Telnyx WebRTC client...");

        const client = new TelnyxRTC({
          login: sipUsername!,
          password: sipPassword!,
          ringtoneFile: undefined,
          ringbackFile: undefined,
        });

        // Handle client ready
        client.on("telnyx.ready", () => {
          console.log("Telnyx WebRTC client ready");
          retryCountRef.current = 0;
          setIsClientReady(true);
          readyResolveRef.current?.();
          isInitializing.current = false;
          // Only persist credentials after they've been verified by successful login
          if (credsRef.current?.sipUsername && credsRef.current?.sipPassword) {
            writeStoredCreds(userId, credsRef.current);
          }
        });

        // Handle errors
        client.on("telnyx.error", (error: any) => {
          // Ignore events from orphaned clients (ref was already nulled or replaced)
          if (clientRef.current !== client) return;
          const errCode = error?.error?.code;
          const errMsg = error?.error?.message;
          const isLoginError = errCode === -32001 || (typeof errMsg === 'string' && errMsg.toLowerCase().includes('login incorrect'));

          if (isLoginError) {
            // Login credentials rejected — clear cached creds so we fetch fresh ones on retry
            console.log("Telnyx login rejected — clearing cached credentials");
            credsRef.current = null;
            try { localStorage.removeItem(`greencaller_telnyx_creds_v1:${userId}`); } catch {}
            failInit("Telnyx WebRTC error:", error);
            // Only show toast after 2+ consecutive failures to avoid flash on stale-cred retry
            if (retryCountRef.current >= 2) {
              toast({
                title: "Connection Error",
                description: "Failed to connect to Telnyx. Retrying...",
                variant: "destructive",
              });
            }
          } else if (isInitializing.current) {
            // Fatal error during initialization — retry
            failInit("Telnyx WebRTC error:", error);
            if (retryCountRef.current >= 2) {
              toast({
                title: "Connection Error",
                description: "Failed to connect to Telnyx. Retrying...",
                variant: "destructive",
              });
            }
          } else {
            // Non-fatal error while client is already connected (e.g. call-level error after hangup)
            // Don't tear down the connection — socket.close handler covers actual disconnections
            console.warn("Telnyx WebRTC non-fatal error (client active):", error);
          }
        });

        // Handle socket close (auto-reconnect)
        client.on("telnyx.socket.close", () => {
          console.log("Telnyx WebRTC socket closed — activeCall:", !!activeCallRef.current, "callActive:", callStateRef?.current?.isActive);
          // Ignore events from orphaned clients (ref was already nulled or replaced)
          if (clientRef.current !== client) return;
          // If client was already ready (not during init), try reconnecting the same client
          // instead of tearing down and creating a new one (avoids credential rotation)
          if (!isInitializing.current) {
            console.log("Attempting to reconnect existing Telnyx client...");
            setIsClientReady(false);
            try {
              client.connect();
              return;
            } catch (e) {
              console.error("Failed to reconnect existing client:", e);
            }
          }
          failInit("Telnyx socket closed");
        });

        // Helper to attach remote stream as soon as it's available
        const attachRemoteStream = (call: any) => {
          try {
            const remoteStream = call.remoteStream || call.options?.remoteStream;
            if (remoteStream && remoteAudioRef.current) {
              if (remoteAudioRef.current.srcObject !== remoteStream) {
                console.log("Attaching remote audio stream");
                remoteAudioRef.current.srcObject = remoteStream;
                remoteAudioRef.current.play().catch((e: any) => {
                  console.warn("Failed to play remote audio:", e);
                });
              }
            }
          } catch (e) {
            console.error("Error attaching remote audio:", e);
          }
        };

        // Handle incoming calls
        client.on("telnyx.notification", (notification: any) => {
          console.log("Telnyx notification:", notification.type, notification.call?.state, notification.call?.direction);

          if (notification.type === "callUpdate") {
            const call = notification.call;
            const callState = call.state;
            const callDirection = call.direction;

            // Opportunistically capture the PSTN Call Control ID for inbound calls.
            // This fixes transfer/recording actions that must target the PSTN leg.
            const pstnId = extractPstnCallControlId(call);
            if (pstnId) {
              setCallState((prev) => (prev.pstnCallControlId === pstnId ? prev : { ...prev, pstnCallControlId: pstnId }));
            }

            // Extract caller number from multiple possible sources
            // Priority: SIP headers (X-Original-Caller), then explicit caller ID fields, then generic from
            // Note: call.from on inbound SIP calls often contains the SIP URI which is not useful
            let callerNumber = call.options?.remoteCallerNumber
              || call.options?.callerNumber
              || call.remoteCallerNumber;

            // Check SIP custom headers for X-Original-Caller
            const sipHeaders = call.options?.customHeaders || call.options?.sipHeaders || [];
            const originalCallerHeader = sipHeaders.find?.((h: any) =>
              h.name?.toLowerCase() === 'x-original-caller' ||
              h.name?.toLowerCase() === 'p-asserted-identity'
            );
            if (originalCallerHeader?.value) {
              // Extract phone number from SIP header (might be full SIP URI or just number)
              const match = originalCallerHeader.value.match(/\+?\d+/);
              if (match) {
                callerNumber = match[0].startsWith('+') ? match[0] : '+' + match[0];
              }
            }

            // If still no caller number, check call.from but filter out SIP URIs
            if (!callerNumber && call.from) {
              const fromValue = call.from;
              // If it looks like a phone number (starts with + or is mostly digits), use it
              if (/^\+?\d{7,}$/.test(fromValue.replace(/[\s\-()]/g, ''))) {
                callerNumber = fromValue;
              } else if (fromValue.includes('@')) {
                // It's a SIP URI - try to extract a phone number from the user part
                const userPart = fromValue.split('@')[0].replace('sip:', '');
                if (/^\+?\d{7,}$/.test(userPart.replace(/[\s\-()]/g, ''))) {
                  callerNumber = userPart;
                }
              }
            }

            callerNumber = callerNumber || "Unknown";

            console.log("Call update:", {
              state: callState,
              direction: callDirection,
              callerNumber,
              callId: call.id,
              options: call.options,
              from: call.from,
            });

            // Detect incoming calls more robustly
            // TeXML-routed SIP calls may not have direction set correctly
            // Key indicators of incoming call:
            // 1. direction === "inbound"
            // 2. state is "ringing", "new", "trying", "early" AND we don't have an active outbound call
            // 3. This call is NOT already our active call (prevents re-triggering after answer)
            const isAlreadyActiveCall = activeCallRef.current?.id === call.id;
            const isInboundByDirection = callDirection === "inbound" && !isAlreadyActiveCall;
            const isLikelyInbound = !activeCallRef.current &&
              ["ringing", "new", "trying", "early"].includes(callState) &&
              callDirection !== "outbound";

            // Check if this is a bridged call we're waiting for (outbound call bridge-back)
            // If we initiated an outbound call via edge function, auto-answer the incoming SIP leg
            // Also detect bridge-back calls by metadata: if callState shows isActive (we initiated
            // an outbound call) and the incoming SIP has callerName "Outbound Call" or matches
            // our pending call number, treat it as a bridge-back even if the ref was cleared.
            const isBridgeByRef = !!awaitingBridgeRef.current;
            const isBridgeByState = !isBridgeByRef &&
              callStateRef?.current?.isActive &&
              callStateRef?.current?.phoneNumber &&
              !activeCallRef.current &&
              (call.options?.callerName === 'Outbound Call' ||
               call.options?.remoteCallerName === 'Outbound Call');

            console.log("Bridge check:", { isBridgeByRef, isBridgeByState, awaitingBridge: awaitingBridgeRef.current, callActive: callStateRef?.current?.isActive, callerName: call.options?.callerName || call.options?.remoteCallerName });

            if ((isBridgeByRef || isBridgeByState) &&
              (isInboundByDirection || isLikelyInbound) &&
              ["ringing", "new", "trying", "early"].includes(callState)) {
              console.log("Auto-answering bridged call for outbound PSTN call:", awaitingBridgeRef.current || callStateRef?.current?.phoneNumber);

              // Clear the bridge flag before answering
              const bridgeInfo = awaitingBridgeRef.current || {
                toNumber: callStateRef?.current?.phoneNumber || callerNumber,
                fromNumber: assignedNumber || '',
              };
              awaitingBridgeRef.current = null;

              // Set this as our active call and answer it automatically
              activeCallRef.current = call;
              incomingCallRef.current = null; // Not an incoming call UI-wise

              try {
                call.answer();
                console.log("Bridged call answered successfully");

                // Update call state to reflect the active outbound call
                setCallState((prev) => ({
                  ...prev,
                  isActive: true,
                  phoneNumber: bridgeInfo.toNumber,
                  callId: call.id,
                }));

                attachRemoteStream(call);
              } catch (e) {
                console.error("Error answering bridged call:", e);
              }
              return; // Don't process as regular incoming call
            }

            // Queue pickup calls now use transfer-based approach
            // The caller is transferred to the agent's number, which rings as a normal incoming call
            // No auto-answer needed - just let it ring and show the incoming call modal

            // Check if this caller was recently declined (blocks new INVITEs from same caller)
            const declinedAt = callerNumber ? declinedCallersRef.current.get(callerNumber) : undefined;
            const isCallerRecentlyDeclined = declinedAt && (Date.now() - declinedAt) < 65000;

            // Only show incoming modal if:
            // - It's a new inbound call we haven't seen
            // - We're not already handling it as incoming or active
            // - We're not waiting for a bridge (outbound call) or queue pickup
            // - The call hasn't already been declined/sent to voicemail (by ID or caller number)
            if (isCallerRecentlyDeclined) {
              console.log("Blocking re-detection of recently declined caller:", callerNumber, "call.id:", call.id);
              // Also hangup this new SIP invite so the platform stops retrying
              try { call.hangup({ cause: "USER_BUSY", causeCode: 17, sipCode: 486 }); } catch {}
            } else if ((isInboundByDirection || isLikelyInbound) && !incomingCallRef.current && !isAlreadyActiveCall && !declinedCallIdsRef.current.has(call.id)) {
              console.log("Incoming Telnyx call detected:", callerNumber, "direction:", callDirection, "state:", callState);

              // Store reference to prevent duplicate detection
              incomingCallRef.current = call;

              setIncomingCall({
                isIncoming: true,
                isDismissed: false,
                phoneNumber: callerNumber || "Unknown",
                call: call,
              });
            }

            // Attach remote stream on any state that might have audio (early media, answering, active)
            if (["trying", "early", "answering", "active"].includes(callState)) {
              attachRemoteStream(call);
            }

            // Handle call state changes
            if (callState === "active") {
              console.log("Telnyx call active");
              attachRemoteStream(call);

              // Ensure we store PSTN ID once the call is fully active as well.
              const pstnActiveId = extractPstnCallControlId(call);
              if (pstnActiveId) {
                setCallState((prev) => (prev.pstnCallControlId === pstnActiveId ? prev : { ...prev, pstnCallControlId: pstnActiveId }));
              }

              if (activeCallRef.current?.id === call.id) {
                startDurationTimer();
              }
            }

            if (callState === "hangup" || callState === "destroy") {
              console.log("Telnyx call ended — state:", callState, "cause:", call.cause, "causeCode:", call.causeCode, "sipCode:", call.sipCode, "id:", call.id, "direction:", call.direction);
              if (activeCallRef.current?.id === call.id) {
                resetCallState();
              }
              // Clear incoming call ref and state if it was this call
              if (incomingCallRef.current?.id === call.id) {
                incomingCallRef.current = null;
              }
              // Clean up declined call tracking after a delay.
              // Don't delete immediately — hangup() fires this synchronously
              // BEFORE the BYE reaches the platform, so late "ringing" events
              // can still arrive and re-trigger the incoming call modal.
              const declinedCallId = call.id;
              if (declinedCallId && declinedCallIdsRef.current.has(declinedCallId)) {
                setTimeout(() => {
                  declinedCallIdsRef.current.delete(declinedCallId);
                }, 15000); // Keep blocked for 15s to cover any late events
              }
              setIncomingCall((prev) => {
                if (prev.call?.id === call.id) {
                  return {
                    isIncoming: false,
                    isDismissed: false,
                    phoneNumber: "",
                    call: null,
                  };
                }
                return prev;
              });
            }
          }
        });

        await client.connect();
        clientRef.current = client;
        console.log("Telnyx WebRTC client connected");

        // Safety: if we never get telnyx.ready within 12s, treat as failed init
        const initTimeoutId = window.setTimeout(() => {
          // Only fail if the client hasn't successfully set ready
          if (isInitializing.current && !clientRef.current) {
            failInit("Telnyx ready timeout");
          }
        }, 12000);

        // Clear timeout if we do become ready
        client.on("telnyx.ready", () => {
          window.clearTimeout(initTimeoutId);
        });
      } catch (error) {
        failInit("Error initializing Telnyx client:", error);
      }
    };

    initializeTelnyxClient();

    return () => {
      if (clientRef.current) {
        try {
          clientRef.current.disconnect();
        } catch {
          // ignore
        }
        clientRef.current = null;
      }
      // Clean up remote audio element
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current.remove();
        remoteAudioRef.current = null;
      }
      isInitializing.current = false;
      retryCountRef.current = 0;
    };
  }, [userId, enabled, toast, startDurationTimer, resetCallState]);

  // Heartbeat: Keep SIP registration fresh by updating the timestamp every 60 seconds
  // This ensures incoming calls can detect if the WebRTC client is actually connected
  useEffect(() => {
    if (!isClientReady || !userId || !credsRef.current?.sipUsername) {
      return;
    }

    const updateRegistration = async () => {
      try {
        const sipUsername = credsRef.current?.sipUsername;
        const expiresAt = credsRef.current?.expiresAt;
        const { error } = await supabase
          .from('telnyx_webrtc_registrations')
          .update({
            updated_at: new Date().toISOString(),
            ...(sipUsername ? { sip_username: sipUsername } : {}),
            ...(expiresAt ? { expires_at: expiresAt } : {}),
          })
          .eq('user_id', userId);

        if (error) {
          console.error('Heartbeat: Failed to update registration:', error);
        } else {
          lastHeartbeatRef.current = Date.now();
          setIsRegistrationStale(false);
          console.log('Heartbeat: Registration updated');
        }
      } catch (e) {
        console.error('Heartbeat error:', e);
      }
    };

    // Check if heartbeat has gone stale (>120 seconds since last success)
    const checkStale = () => {
      const elapsed = (Date.now() - lastHeartbeatRef.current) / 1000;
      if (elapsed > 120) {
        setIsRegistrationStale(true);
      }
    };

    // Update immediately when client becomes ready
    updateRegistration();

    // Then update every 60 seconds, check staleness every 30 seconds
    const heartbeatInterval = window.setInterval(updateRegistration, 60000);
    const staleCheckInterval = window.setInterval(checkStale, 30000);

    // When tab becomes visible again, immediately refresh the heartbeat
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const elapsed = (Date.now() - lastHeartbeatRef.current) / 1000;
        console.log('Tab became visible, seconds since last heartbeat:', Math.round(elapsed));
        if (elapsed > 90) {
          setIsRegistrationStale(true);
        }
        // Always refresh when tab becomes visible
        updateRegistration();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(heartbeatInterval);
      window.clearInterval(staleCheckInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isClientReady, userId]);

  // Make an outbound call via the telnyx-make-call edge function
  // The edge function initiates a PSTN call and bridges it to the user's WebRTC client
  const makeCall = useCallback(
    async (toNumber: string, record: boolean = false) => {
      if (!assignedNumber) {
        toast({
          title: "No phone number assigned",
          description: "Please contact admin to assign a phone number",
          variant: "destructive",
        });
        return;
      }

      if (!userId) {
        toast({
          title: "Not logged in",
          description: "Please log in to make calls",
          variant: "destructive",
        });
        return;
      }

      // Wait for WebRTC client to be ready (needed to receive the bridged call)
      const waitForReady = async () => {
        if (clientRef.current && isClientReady) return true;

        // Wait up to 10s for the SDK to become ready
        try {
          await Promise.race([
            readyPromiseRef.current ?? Promise.reject(new Error('No Telnyx init in progress')),
            new Promise((_, reject) => window.setTimeout(() => reject(new Error('timeout')), 10000)),
          ]);
        } catch {
          // ignore
        }

        return !!clientRef.current && isClientReady;
      };

      if (!(await waitForReady())) {
        toast({
          title: "Client not ready",
          description: "Still connecting to Telnyx, please try again in a moment.",
          variant: "destructive",
        });
        return;
      }

      try {
        // Format phone number to E.164
        let formattedNumber = toNumber.replace(/[^\d+]/g, "");
        if (formattedNumber.startsWith("0")) {
          formattedNumber = "+44" + formattedNumber.substring(1);
        }
        if (!formattedNumber.startsWith("+")) {
          formattedNumber = "+" + formattedNumber;
        }

        console.log("Making Telnyx call via edge function to:", formattedNumber);

        // Set the awaiting bridge flag so we auto-answer the incoming SIP call
        awaitingBridgeRef.current = { toNumber: formattedNumber, fromNumber: assignedNumber };

        setCallState((prev) => ({
          ...prev,
          isActive: true,
          phoneNumber: toNumber,
          isRecording: record,
        }));

        toast({
          title: "Initiating call...",
          description: `Calling ${toNumber} from ${assignedNumber}`,
        });

        // Call the edge function to initiate the PSTN call
        const { data, error } = await supabase.functions.invoke("telnyx-make-call", {
          body: {
            toNumber: formattedNumber,
            fromNumber: assignedNumber,
            userId,
            record,
          },
        });

        if (error || !data?.success) {
          console.error("Telnyx make-call error:", error || data?.error);
          awaitingBridgeRef.current = null; // Clear bridge flag on failure
          resetCallState();
          toast({
            title: "Call failed",
            description: data?.error || error?.message || "Failed to initiate call.",
            variant: "destructive",
          });
          return;
        }

        console.log("Telnyx call initiated:", data);

        // Store the PSTN call control ID for recording purposes
        setCallState((prev) => ({
          ...prev,
          callId: data.callControlId,
          pstnCallControlId: data.callControlId, // This is the PSTN leg we can control for recording
        }));

        // Start the duration timer - the call is being connected
        startDurationTimer();

        toast({
          title: "Call initiated",
          description: `Calling ${toNumber} - connecting...`,
        });
      } catch (error: any) {
        console.error("Error making Telnyx call:", error);
        awaitingBridgeRef.current = null; // Clear bridge flag on failure
        resetCallState();
        toast({
          title: "Call failed",
          description: error.message || "Failed to initiate call.",
          variant: "destructive",
        });
      }
    },
    [assignedNumber, userId, isClientReady, resetCallState, startDurationTimer, toast]
  );

  // End the current call
  const endCall = useCallback(async () => {
    const finalDuration = callState.duration;
    const wasRecording = callState.isRecording;
    const callId = callState.pstnCallControlId || callState.callId;
    const phoneNumber = callState.phoneNumber;

    // For PSTN hangup, we need a valid Telnyx Call Control ID (starts with "v3:")
    // The pstnCallControlId is set for outbound calls initiated via telnyx-make-call
    // For inbound TeXML calls, we only have the WebRTC SIP leg ID which is a UUID
    const pstnCallId = callState.pstnCallControlId;
    const isValidPstnId = pstnCallId && (pstnCallId.startsWith('v3:') || pstnCallId.startsWith('v2:'));

    // Block late callUpdate events from re-triggering the incoming call modal
    // after the active call ends and activeCallRef is cleared.
    // Only block the current call's ID (not the phone number) so that
    // if the same person calls again after the call ends, the modal shows.
    if (activeCallRef.current?.id) {
      declinedCallIdsRef.current.add(activeCallRef.current.id);
    }

    // Hang up the WebRTC leg
    if (activeCallRef.current) {
      try {
        activeCallRef.current.hangup();
      } catch (e) {
        console.warn("WebRTC hangup error (ignored):", e);
      }
    }

    // Also hang up the PSTN leg via the Telnyx API if we have a valid PSTN call control ID
    // This is mainly for outbound calls where we initiated the PSTN leg
    if (isValidPstnId) {
      try {
        console.log("Hanging up PSTN leg:", pstnCallId);
        await supabase.functions.invoke("telnyx-hangup-call", {
          body: { callControlId: pstnCallId },
        });
      } catch (e) {
        console.warn("PSTN hangup error (ignored):", e);
      }
    } else if (assignedNumber && phoneNumber) {
      // For inbound TeXML calls, the pstnCallControlId is a UUID (TeXML CallSid),
      // not a v2:/v3: Call Control ID. Use the TeXML Call Update API to terminate
      // the PSTN leg, otherwise the caller stays connected after we hang up.
      try {
        console.log("Terminating inbound TeXML call via API");
        await supabase.functions.invoke("telnyx-send-to-voicemail", {
          body: {
            callId: null,
            toNumber: assignedNumber,
            fromNumber: phoneNumber,
            action: "decline",
          },
        });
      } catch (e) {
        console.warn("TeXML termination error (ignored):", e);
      }
    }

    // Update call_history with final status and duration via backend (bypasses RLS)
    console.log("Ending call - duration:", finalDuration, "callId:", callId);

    try {
      const { data, error } = await supabase.functions.invoke('update-call-status', {
        body: { callId, status: 'completed', duration: finalDuration }
      });
      if (error) {
        console.error("Failed to update call status:", error);
      } else {
        console.log("SUCCESS: Updated call status:", data);
      }
    } catch (e) {
      console.error("Exception updating call_history:", e);
    }

    // For inbound calls that were recording, manually save the recording
    // This is needed because TeXML recording webhooks don't always reach our endpoint
    if (wasRecording && callId) {
      console.log("Saving recording for inbound call:", callId);
      // Delay slightly to ensure recording is saved on Telnyx side
      setTimeout(async () => {
        try {
          const { data, error } = await supabase.functions.invoke("telnyx-save-recording", {
            body: {
              callId,
              userId,
              fromNumber: phoneNumber,
              toNumber: assignedNumber,
              direction: 'inbound',
            },
          });
          if (error) {
            console.error("Failed to save recording:", error);
          } else {
            console.log("Recording save result:", data);
          }
        } catch (e) {
          console.error("Error saving recording:", e);
        }
      }, 2000); // Wait 2 seconds for Telnyx to process the recording
    }

    stopDurationTimer();

    toast({
      title: "Call ended",
      description: `Duration: ${Math.floor(finalDuration / 60)}:${(finalDuration % 60)
        .toString()
        .padStart(2, "0")}`,
    });

    resetCallState();
  }, [callState.duration, callState.pstnCallControlId, callState.callId, callState.isRecording, callState.phoneNumber, userId, assignedNumber, stopDurationTimer, resetCallState, toast]);

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (activeCallRef.current) {
      const newMuted = !callState.isMuted;
      if (newMuted) {
        activeCallRef.current.muteAudio();
      } else {
        activeCallRef.current.unmuteAudio();
      }
      setCallState((prev) => ({ ...prev, isMuted: newMuted }));
      toast({
        title: newMuted ? "Muted" : "Unmuted",
        description: newMuted ? "Microphone is now off" : "Microphone is now on",
      });
    }
  }, [callState.isMuted, toast]);

  // Toggle hold
  const toggleHold = useCallback(async () => {
    if (activeCallRef.current) {
      const newHoldState = !callState.isOnHold;
      try {
        if (newHoldState) {
          activeCallRef.current.hold();
        } else {
          activeCallRef.current.unhold();
        }
        setCallState((prev) => ({ ...prev, isOnHold: newHoldState }));
        toast({
          title: newHoldState ? "Call On Hold" : "Call Resumed",
          description: newHoldState
            ? "Caller is now on hold"
            : "Call has been resumed",
        });
      } catch (error: any) {
        console.error("Error toggling hold:", error);
        toast({
          title: "Hold failed",
          description: error.message || "Failed to toggle hold",
          variant: "destructive",
        });
      }
    }
  }, [callState.isOnHold, toast]);

  // Toggle recording (via backend API)
  // Uses pstnCallControlId because recording must happen on the PSTN leg, not the WebRTC leg
  const toggleRecording = useCallback(async () => {
    if (!callState.isActive) return;

    // For recording, we need the PSTN leg's call ID
    // This can be either:
    // - Call Control ID (v2:/v3: prefix) for outbound calls
    // - TeXML CallSid (UUID) for inbound calls
    const recordingCallId = callState.pstnCallControlId || callState.callId;
    if (!recordingCallId) {
      toast({
        title: "Cannot record",
        description: "No PSTN call leg available for recording",
        variant: "destructive",
      });
      return;
    }

    // Check if we have a valid call ID format
    const isCallControlId = recordingCallId.startsWith('v2:') || recordingCallId.startsWith('v3:');
    const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordingCallId);

    if (!isCallControlId && !isValidUUID) {
      toast({
        title: "Recording not available",
        description: "Call ID format not recognized for recording",
      });
      return;
    }

    console.log('Starting recording with call ID:', recordingCallId, 'type:', isCallControlId ? 'call_control' : 'texml');

    try {
      if (!callState.isRecording) {
        toast({ title: "Starting recording..." });
        // Start recording via Telnyx API
        const { data, error } = await supabase.functions.invoke("telnyx-start-recording", {
          body: {
            callId: recordingCallId,
            userId,
            fromNumber: assignedNumber,
            toNumber: callState.phoneNumber,
          },
        });

        if (error) throw error;
        if (data && !data.success) {
          throw new Error(data.error || "Failed to start recording");
        }
        console.log('Recording started, call type:', data?.callType);
        setCallState((prev) => ({ ...prev, isRecording: true, isPaused: false }));
        toast({ title: "Recording Started" });
      } else if (!callState.isPaused) {
        // Pause recording
        const { error } = await supabase.functions.invoke("telnyx-pause-recording", {
          body: { callId: recordingCallId },
        });
        if (error) throw error;
        setCallState((prev) => ({ ...prev, isPaused: true }));
        toast({ title: "Recording Paused" });
      } else {
        // Resume recording
        const { error } = await supabase.functions.invoke("telnyx-resume-recording", {
          body: { callId: recordingCallId },
        });
        if (error) throw error;
        setCallState((prev) => ({ ...prev, isPaused: false }));
        toast({ title: "Recording Resumed" });
      }
    } catch (error: any) {
      console.error("Error toggling recording:", error);
      toast({
        title: "Recording Error",
        description: error.message || "Failed to toggle recording",
        variant: "destructive",
      });
    }
  }, [callState, userId, assignedNumber, toast]);

  // Transfer call via backend API (Telnyx WebRTC SDK doesn't have client-side transfer)
  const transferCall = useCallback(
    async (targetId: string, targetType: "user" | "department") => {
      if (!callState.isActive) return;

      // Get the PSTN call control ID for transfer - this is the actual phone leg
      const callControlId = callState.pstnCallControlId || callState.callId;
      if (!callControlId) {
        toast({
          title: "Transfer failed",
          description: "No active call to transfer",
          variant: "destructive",
        });
        return;
      }

      try {
        let targetNumber: string | null = null;

        if (targetType === "user") {
          const { data: phoneData } = await supabase
            .from("phone_numbers")
            .select("phone_number")
            .eq("assigned_to", targetId)
            .eq("is_active", true)
            .single();
          targetNumber = phoneData?.phone_number || null;
        } else {
          const { data: deptData } = await supabase
            .from("departments")
            .select("phone_number_id")
            .eq("id", targetId)
            .single();

          if (deptData?.phone_number_id) {
            const { data: phoneData } = await supabase
              .from("phone_numbers")
              .select("phone_number")
              .eq("id", deptData.phone_number_id)
              .single();
            targetNumber = phoneData?.phone_number || null;
          }
        }

        if (!targetNumber) {
          toast({
            title: "Transfer failed",
            description: "No phone number found for target",
            variant: "destructive",
          });
          return;
        }

        toast({
          title: "Transferring call...",
          description: `Transferring to ${targetNumber}`,
        });

        // Use backend edge function to transfer via Telnyx TeXML/Call Control API
        const { data, error } = await supabase.functions.invoke("telnyx-transfer-call", {
          body: {
            callControlId,
            targetNumber,
            targetId,
            targetType,
            userId,
          },
        });

        if (error) throw error;
        if (data && !data.success) throw new Error(data.error || "Transfer failed");

        toast({
          title: "Transfer initiated",
          description: "Call is being transferred",
        });

        // End our local call after transfer is initiated
        if (activeCallRef.current) {
          try {
            activeCallRef.current.hangup();
          } catch (e) {
            console.log("Call already ended after transfer");
          }
        }
        resetCallState();
      } catch (error: any) {
        console.error("Error transferring call:", error);
        toast({
          title: "Transfer failed",
          description: error.message || "Failed to transfer call",
          variant: "destructive",
        });
      }
    },
    [callState.isActive, callState.pstnCallControlId, callState.callId, resetCallState, toast]
  );

  // Answer incoming call
  const answerIncomingCall = useCallback(async () => {
    if (!incomingCall.call) return;

    // Guard: ensure the Telnyx WebRTC client is still connected
    if (!clientRef.current || !isClientReady) {
      toast({
        title: "Phone not ready",
        description: "Please wait a moment and try again, or refresh the page",
        variant: "destructive",
      });
      incomingCallRef.current = null;
      setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
      return;
    }

    try {
      // Pre-acquire microphone permission before calling answer().
      // The Telnyx SDK internally calls getUserMedia inside answer() → peer.init().
      // If getUserMedia fails (no mic / permission denied), the SDK continues with
      // a null local stream which corrupts the RTCPeerConnection, leading to:
      //   "Cannot read properties of null (reading 'getTransceivers')"
      // By acquiring the stream first we surface a clear error and also warm the
      // browser permission prompt so the SDK's own getUserMedia succeeds instantly.
      if (navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          // Release the stream immediately – we only needed the permission grant.
          stream.getTracks().forEach((t) => t.stop());
        } catch (micError: any) {
          console.error("Microphone access denied:", micError);

          // Check permission state to give a specific message
          let description = "Please allow microphone access to answer calls.";
          try {
            const permStatus = await navigator.permissions.query({ name: "microphone" as PermissionName });
            if (permStatus.state === "denied") {
              description = "Microphone is blocked. Click the lock/site-settings icon in your address bar and allow microphone access, then refresh.";
            }
          } catch {
            // Permissions API not supported, use generic message
          }

          toast({
            title: "Microphone required",
            description,
            variant: "destructive",
          });
          incomingCallRef.current = null;
          setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
          return;
        }
      }

      console.log("Answering incoming call:", {
        callId: incomingCall.call.id,
        callState: incomingCall.call.state,
        direction: incomingCall.call.direction,
        hasPeer: !!incomingCall.call.peer,
        hasRemoteSdp: !!incomingCall.call.options?.remoteSdp,
        sessionConnected: !!incomingCall.call.session?.connected,
      });
      await incomingCall.call.answer();
      activeCallRef.current = incomingCall.call;
      incomingCallRef.current = null; // Clear the ref since call is now active

      // Extract the PSTN call ID for recording/status updates
      const pstnId = extractPstnCallControlId(incomingCall.call);

      setCallState((prev) => ({
        ...prev,
        isActive: true,
        phoneNumber: incomingCall.phoneNumber,
        callId: incomingCall.call.id,
        pstnCallControlId: pstnId || prev.pstnCallControlId,
      }));

      setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });

      // Update call_history to 'answered' status via backend (bypasses RLS)
      try {
        const { data, error } = await supabase.functions.invoke('update-call-status', {
          body: { callId: pstnId, status: 'answered', direction: 'inbound' }
        });
        console.log("Update call status result:", data, error);
      } catch (e) {
        console.error("Failed to update call status:", e);
      }

      startDurationTimer();
      toast({ title: "Connected", description: `Speaking with ${incomingCall.phoneNumber}` });
    } catch (error: any) {
      console.error("Error answering call:", error);
      incomingCallRef.current = null;
      toast({
        title: "Failed to answer",
        description: error.message || "Could not connect to call",
        variant: "destructive",
      });
      setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
    }
  }, [incomingCall, isClientReady, startDurationTimer, toast, extractPstnCallControlId]);

  // Decline incoming call
  const declineIncomingCall = useCallback(async () => {
    // Extract PSTN call SID before hanging up (SIP headers won't be available after)
    const pstnId = incomingCall.call ? (extractPstnCallControlId(incomingCall.call) || callState.pstnCallControlId) : null;
    const callRef = incomingCall.call;

    // Mark this call ID as handled so late callUpdate events don't re-trigger the modal
    // Don't block by caller number — that prevents future calls from the same number
    if (callRef?.id) {
      declinedCallIdsRef.current.add(callRef.id);
    }

    // Clear incoming call ref and state immediately so new calls can come through
    incomingCallRef.current = null;
    setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
    toast({ title: "Call declined" });

    // Terminate the PSTN leg via the Telnyx TeXML API FIRST, before hanging up WebRTC.
    // If we hang up WebRTC first, the SIP 486 triggers the TeXML action URL (voicemail)
    // before the decline API can send <Hangup/>.
    if (assignedNumber && (pstnId || incomingCall.phoneNumber)) {
      try {
        await supabase.functions.invoke("telnyx-send-to-voicemail", {
          body: {
            callId: pstnId || null,
            toNumber: assignedNumber,
            fromNumber: incomingCall.phoneNumber,
            action: "decline",
          },
        });
      } catch (e) {
        console.error("Error terminating PSTN leg:", e);
      }
    }

    // Now hang up the WebRTC leg after the PSTN leg has been terminated
    if (callRef) {
      try {
        callRef.hangup({ cause: "USER_BUSY", causeCode: 17, sipCode: 486 });
      } catch (e) {
        console.error("Error hanging up WebRTC leg:", e);
      }
    }
  }, [incomingCall, assignedNumber, callState.pstnCallControlId, toast, extractPstnCallControlId]);

  // Dismiss incoming call modal
  const dismissIncomingCall = useCallback(() => {
    setIncomingCall((prev) => ({ ...prev, isIncoming: false, isDismissed: true }));
  }, []);

  // Restore dismissed incoming call
  const restoreIncomingCall = useCallback(() => {
    setIncomingCall((prev) => ({ ...prev, isIncoming: true, isDismissed: false }));
  }, []);

  // Send incoming call to voicemail (before answering)
  // This marks the call status and then declines so the caller gets routed to voicemail
  const sendIncomingToVoicemail = useCallback(async () => {
    if (!incomingCall.call) {
      toast({
        title: "No incoming call",
        description: "There is no incoming call to send to voicemail",
        variant: "destructive",
      });
      return;
    }

    // Save references before clearing state
    const callRef = incomingCall.call;
    const callId = callRef?.id;
    const pstnId = extractPstnCallControlId(callRef) || callState.pstnCallControlId;

    // Mark call ID as handled so late callUpdate events don't re-trigger the modal
    if (callId) {
      declinedCallIdsRef.current.add(callId);
    }

    // Clear incoming call ref and state immediately so new calls can come through
    incomingCallRef.current = null;
    setIncomingCall({ isIncoming: false, isDismissed: false, phoneNumber: "", call: null });
    toast({ title: "Sending to voicemail..." });

    try {
      console.log("Send incoming call to voicemail:", {
        phoneNumber: incomingCall.phoneNumber,
        assignedNumber,
        pstnId,
      });

      // Call the backend to redirect the PSTN call to voicemail via Telnyx TeXML API
      const { data, error } = await supabase.functions.invoke("telnyx-send-to-voicemail", {
        body: {
          callId: pstnId || null,
          toNumber: assignedNumber,
          fromNumber: incomingCall.phoneNumber,
          action: "voicemail",
        },
      });

      if (error) {
        console.error("Send to voicemail error:", error);
      }

      console.log("Send to voicemail response:", data);

      toast({
        title: "Sending to voicemail",
        description: "Caller will be prompted to leave a voicemail",
      });

      // Hang up the WebRTC leg after the edge function has redirected the PSTN call
      if (callRef) {
        try {
          callRef.hangup({ cause: "USER_BUSY", causeCode: 17, sipCode: 486 });
        } catch (e) {
          console.error("Error hanging up WebRTC leg:", e);
        }
      }

    } catch (error: any) {
      console.error("Error sending incoming call to voicemail:", error);
      // Still hang up the WebRTC leg
      if (callRef) {
        try { callRef.hangup({ cause: "USER_BUSY", causeCode: 17, sipCode: 486 }); } catch {}
      }
      toast({
        title: "Failed to send to voicemail",
        description: error.message || "Something went wrong",
        variant: "destructive",
      });
    }
  }, [incomingCall, assignedNumber, callState.pstnCallControlId, toast, extractPstnCallControlId]);

  // Send DTMF tones
  const sendDtmf = useCallback((digit: string) => {
    if (activeCallRef.current) {
      activeCallRef.current.dtmf(digit);
      console.log(`Sent DTMF tone: ${digit}`);
    } else {
      console.warn("No active call to send DTMF");
    }
  }, []);

  // Pickup queued call (for switchboard) - triggers backend to transfer the caller
  // The caller is transferred to the agent's number and will ring as a normal incoming call
  const pickupQueuedCall = useCallback(
    async (callInfo: { phoneNumber: string; conferenceName: string; callSid: string; queueId?: string }) => {
      if (!callInfo.queueId) {
        toast({
          title: "Error",
          description: "Missing queue ID",
          variant: "destructive",
        });
        return;
      }

      try {
        console.log('Picking up queued call (transfer-based):', callInfo);

        toast({
          title: "Transferring caller...",
          description: `Connecting ${callInfo.phoneNumber} to your line`
        });

        // Call the backend to transfer the caller to the agent's SIP endpoint
        // The call will ring on the agent's device like a normal incoming call
        const { data, error } = await supabase.functions.invoke("telnyx-pickup-call", {
          body: {
            queueId: callInfo.queueId,
            userId,
          },
        });

        if (error || !data?.success) {
          throw new Error(data?.error || error?.message || 'Failed to transfer call');
        }

        console.log('Transfer initiated - call should ring shortly:', data);

        toast({
          title: "Call transferred",
          description: "Incoming call will ring on your device shortly"
        });

      } catch (error: any) {
        console.error("Error transferring queued call:", error);
        toast({
          title: "Transfer failed",
          description: error.message || "Failed to transfer call",
          variant: "destructive",
        });
      }
    },
    [userId, toast]
  );

  // Send to voicemail
  // For inbound calls: redirects the caller to voicemail so they can leave a message
  // For outbound calls: redirects the called party to voicemail (less common use case)
  const sendToVoicemail = useCallback(async () => {
    if (!callState.isActive) {
      toast({
        title: "No active call",
        description: "There is no active call to send to voicemail",
        variant: "destructive",
      });
      return;
    }

    try {
      toast({ title: "Sending to voicemail..." });

      // Log what we're sending for debugging
      console.log("Send to voicemail - call state:", {
        callId: callState.callId,
        pstnCallControlId: callState.pstnCallControlId,
        phoneNumber: callState.phoneNumber,
        assignedNumber,
      });

      const { data, error } = await supabase.functions.invoke("telnyx-send-to-voicemail", {
        body: {
          callId: callState.pstnCallControlId || callState.callId,
          toNumber: assignedNumber,
          fromNumber: callState.phoneNumber,
        },
      });

      if (error) {
        console.error("Send to voicemail error response:", error);
        throw error;
      }

      console.log("Send to voicemail response:", data);

      // Handle not_supported action (outbound calls can't be sent to voicemail)
      if (data?.action === 'not_supported') {
        toast({
          title: "Not available for outbound calls",
          description: "Voicemail is for receiving messages from callers. Please end the call normally.",
        });
        return;
      }

      if (data && !data.success && data.action !== 'not_supported') {
        throw new Error(data.error || "Failed to send to voicemail");
      }

      // Handle different response actions
      if (data?.action === 'hangup_for_voicemail') {
        // For inbound TeXML calls, the dial action callback handles voicemail
        // We need to hang up the WebRTC leg to trigger the voicemail flow
        toast({
          title: "Sending to voicemail",
          description: "Caller will be prompted to leave a voicemail",
        });

        // Hang up the WebRTC leg - this triggers the voicemail flow for inbound calls
        if (activeCallRef.current) {
          try {
            activeCallRef.current.hangup();
          } catch (e) {
            console.warn("Error hanging up WebRTC call:", e);
          }
        }
        resetCallState();
      } else if (data?.action === 'redirected') {
        // For outbound Call Control calls, the redirect already happened
        // Don't hang up immediately - let Telnyx handle the disconnection
        // Wait a moment for the redirect to take effect, then clean up
        toast({
          title: "Sent to voicemail",
          description: "Call transferred to voicemail",
        });

        // Wait a short delay before cleaning up to allow redirect to complete
        setTimeout(() => {
          if (activeCallRef.current) {
            try {
              activeCallRef.current.hangup();
            } catch (e) {
              // Call may already be disconnected by Telnyx
              console.log("WebRTC leg already disconnected");
            }
          }
          resetCallState();
        }, 1500);
      } else if (data?.action === 'recording_started') {
        // Legacy action - backend already hung up WebRTC leg
        toast({
          title: "Voicemail recording started",
          description: "Customer can now leave a voicemail",
        });

        if (!data?.webrtcHungUp && activeCallRef.current) {
          try {
            activeCallRef.current.hangup();
          } catch (e) {
            console.log("WebRTC leg already disconnected");
          }
        }
        resetCallState();
      } else if (data?.action === 'voicemail_recording') {
        // For outbound bridged calls - voicemail is recording, agent is muted
        // Do NOT hang up - the call will end naturally when customer finishes
        toast({
          title: "Customer leaving voicemail",
          description: "You are muted. Call ends when customer finishes.",
        });

        // Just reset UI state but DON'T hang up the call
        // The call will disconnect when customer hangs up or presses #
        console.log("Voicemail recording in progress - not hanging up");

        // Reset call state after a short delay to update UI
        // The actual call will end when customer finishes voicemail
        setTimeout(() => {
          resetCallState();
        }, 2000);
      } else {
        // Unknown action - just clean up
        toast({
          title: "Sent to voicemail",
          description: "Caller is now leaving a voicemail",
        });

        if (activeCallRef.current) {
          try {
            activeCallRef.current.hangup();
          } catch (e) {
            console.warn("Error hanging up WebRTC call:", e);
          }
        }
        resetCallState();
      }
    } catch (error: any) {
      console.error("Error sending to voicemail:", error);

      // If the error indicates the call has already ended, show a different message
      const errorMessage = error.message || "Something went wrong";
      const isCallEnded = errorMessage.toLowerCase().includes("ended") ||
        errorMessage.toLowerCase().includes("not found");

      toast({
        title: isCallEnded ? "Call has ended" : "Failed to send to voicemail",
        description: isCallEnded
          ? "The call has already ended or was disconnected"
          : errorMessage,
        variant: "destructive",
      });
    }
  }, [callState, assignedNumber, resetCallState, toast]);

  return {
    callState,
    incomingCall,
    isClientReady,
    isRegistrationStale,
    makeCall,
    endCall,
    toggleMute,
    toggleHold,
    toggleRecording,
    transferCall,
    pickupQueuedCall,
    setCallState,
    answerIncomingCall,
    declineIncomingCall,
    dismissIncomingCall,
    restoreIncomingCall,
    sendToVoicemail,
    sendIncomingToVoicemail,
    sendDtmf,
  };
};
