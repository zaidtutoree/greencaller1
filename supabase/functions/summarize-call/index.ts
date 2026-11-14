// AI call summary.
// Input: { recordingId, force? }
// - Returns the cached ai_summary if present (unless force=true).
// - If the recording has no transcription yet, transcribes it on demand by
//   invoking the existing `transcribe-recording` function, then summarizes.
// - Summarizes the transcript with OpenAI gpt-5.4-nano and caches the result
//   in call_recordings.ai_summary.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { recordingId, force } = await req.json();
    if (!recordingId) {
      return json({ error: "recordingId is required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openAIApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openAIApiKey) {
      return json({ error: "OPENAI_API_KEY not configured" }, 500);
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Load the recording.
    const { data: recording, error: fetchError } = await supabase
      .from("call_recordings")
      .select("*")
      .eq("id", recordingId)
      .single();

    if (fetchError || !recording) {
      return json({ error: "Recording not found" }, 404);
    }

    // Cached summary — return instantly unless a refresh was requested.
    if (recording.ai_summary && !force) {
      return json({ summary: recording.ai_summary, cached: true });
    }

    // Ensure we have a transcript. If not, transcribe on demand — but with
    // save=false so the transcript is used only to build the summary and does
    // NOT appear in the Recordings tab (that only happens when the user clicks
    // Transcribe explicitly). An already-saved transcript is reused as-is.
    let transcription: string | null = recording.transcription;
    if (!transcription || !transcription.trim()) {
      console.log("No transcription yet — invoking transcribe-recording (save=false) for", recordingId);
      const transcribeRes = await fetch(`${supabaseUrl}/functions/v1/transcribe-recording`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recordingId, save: false }),
      });
      const transcribeBody = await transcribeRes.json().catch(() => ({}));
      if (!transcribeRes.ok || !transcribeBody?.transcription) {
        return json(
          {
            error:
              "Could not transcribe this recording" +
              (transcribeBody?.error ? `: ${transcribeBody.error}` : ""),
          },
          422,
        );
      }
      transcription = transcribeBody.transcription;
    }

    // Build a human-readable transcript: the stored format uses [CALLER]/[RECIPIENT]
    // markers. Map them to Business/Customer based on call direction so the model
    // has clear context about who is who.
    const isOutbound = recording.direction === "outbound";
    const readableTranscript = (transcription as string)
      .split("\n")
      .map((line) => {
        if (line.startsWith("[CALLER]:")) {
          const who = isOutbound ? "Business" : "Customer";
          return `${who}: ${line.replace("[CALLER]:", "").trim()}`;
        }
        if (line.startsWith("[RECIPIENT]:")) {
          const who = isOutbound ? "Customer" : "Business";
          return `${who}: ${line.replace("[RECIPIENT]:", "").trim()}`;
        }
        return line;
      })
      .join("\n");

    const durationMin = recording.duration ? Math.round((recording.duration / 60) * 10) / 10 : null;
    const meta = [
      `Direction: ${recording.direction}`,
      `From: ${recording.from_number}`,
      `To: ${recording.to_number}`,
      durationMin != null ? `Duration: ~${durationMin} min` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const systemPrompt =
      "You are an assistant that writes concise, accurate summaries of phone calls for a business phone app. " +
      "Summarize only what is in the transcript — never invent details. If the transcript is too short or unclear " +
      "to summarize, say so briefly. Use plain language.";

    const userPrompt =
      `Summarize the following call.\n\nCall details:\n${meta}\n\n` +
      `Transcript:\n${readableTranscript}\n\n` +
      `Write the summary in this exact format using markdown:\n` +
      `**Overview:** one sentence on what the call was about and its outcome.\n\n` +
      `**Key points:**\n- bullet points of the main things discussed\n\n` +
      `**Action items:**\n- any follow-ups, commitments, or next steps (write "None" if there are none)\n\n` +
      `Keep it tight — no more than ~150 words total.`;

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openAIApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        reasoning_effort: "none",
        max_completion_tokens: 600,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error("OpenAI error:", errText);
      return json({ error: `Summary generation failed: ${errText}` }, 502);
    }

    const openaiData = await openaiRes.json();
    const summary: string = openaiData.choices?.[0]?.message?.content?.trim() || "";
    if (!summary) {
      return json({ error: "Empty summary returned" }, 502);
    }

    // Cache it.
    const { error: updateError } = await supabase
      .from("call_recordings")
      .update({ ai_summary: summary })
      .eq("id", recordingId);
    if (updateError) {
      console.error("Failed to save summary:", updateError);
      // Still return the summary even if caching failed.
    }

    return json({ summary, cached: false });
  } catch (error) {
    console.error("Error in summarize-call:", error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
