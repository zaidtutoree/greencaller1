import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const recordingSid = url.searchParams.get("sid");
    const recordingUrl = url.searchParams.get("url");

    if (!recordingSid && !recordingUrl) {
      return new Response(JSON.stringify({ error: "Missing sid or url parameter" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const telnyxApiKey = Deno.env.get("TELNYX_API_KEY");

    // Strategy 1: Use recording_sid to get a fresh download URL from Telnyx API
    if (recordingSid && telnyxApiKey) {
      console.log("Fetching recording via Telnyx API, sid:", recordingSid);

      const apiResponse = await fetch(`https://api.telnyx.com/v2/recordings/${recordingSid}`, {
        headers: { "Authorization": `Bearer ${telnyxApiKey}` },
      });

      if (apiResponse.ok) {
        const details = await apiResponse.json();
        const freshUrl = details?.data?.download_urls?.mp3 || details?.data?.recording_urls?.mp3;
        console.log("Fresh download URL:", freshUrl ? "obtained" : "not available");

        if (freshUrl) {
          const audioResponse = await fetch(freshUrl);
          if (audioResponse.ok) {
            const contentType = audioResponse.headers.get("content-type") || "audio/mpeg";
            const body = await audioResponse.arrayBuffer();
            console.log("Success, size:", body.byteLength);
            return new Response(body, {
              status: 200,
              headers: {
                ...corsHeaders,
                "Content-Type": contentType,
                "Content-Length": body.byteLength.toString(),
              },
            });
          }
          console.log("Fresh URL fetch failed:", audioResponse.status);
        }
      } else {
        console.log("Telnyx API returned:", apiResponse.status);
      }
    }

    // Strategy 2: Try the original URL directly (might still be valid if recent)
    if (recordingUrl) {
      console.log("Trying original URL directly...");
      const directResponse = await fetch(recordingUrl);
      if (directResponse.ok) {
        const contentType = directResponse.headers.get("content-type") || "audio/mpeg";
        const body = await directResponse.arrayBuffer();
        console.log("Success with direct URL, size:", body.byteLength);
        return new Response(body, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": contentType,
            "Content-Length": body.byteLength.toString(),
          },
        });
      }
      console.log("Direct URL failed:", directResponse.status);
    }

    return new Response(
      JSON.stringify({ error: "Recording not found or expired" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Proxy error:", error);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
