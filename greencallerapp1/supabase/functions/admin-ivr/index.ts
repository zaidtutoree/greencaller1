import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
};

async function validateAdminToken(token: string): Promise<{ valid: boolean; adminId?: string }> {
  const url = `${SUPABASE_URL}/rest/v1/admin_sessions?token=eq.${encodeURIComponent(token)}&select=*,admin_users(*)`;
  const response = await fetch(url, {
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  if (!response.ok) return { valid: false };

  const sessions = await response.json();
  if (!sessions || sessions.length === 0) return { valid: false };

  const session = sessions[0];
  const expiresAt = new Date(session.expires_at);
  if (expiresAt <= new Date()) return { valid: false };

  return { valid: true, adminId: session.admin_id };
}

async function supabaseQuery(query: string, method: string = "GET", body?: any) {
  const url = `${SUPABASE_URL}/rest/v1/${query}`;
  const options: RequestInit = {
    method,
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=representation" : (method === "DELETE" ? "return=minimal" : "return=representation"),
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase error: ${error}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const adminToken = req.headers.get("x-admin-token");
    if (!adminToken) {
      return new Response(
        JSON.stringify({ error: "Admin token required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { valid } = await validateAdminToken(adminToken);
    if (!valid) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired admin token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { action, configId, companyName, phoneNumberId, greetingMessage, voice, menuOptions } = await req.json();

    switch (action) {
      case "list": {
        // Get all IVR configurations with their menu options
        const configs = await supabaseQuery(
          "ivr_configurations?select=*,ivr_menu_options(id,digit,label,department_id,user_id)&order=company_name"
        );
        return new Response(
          JSON.stringify({ success: true, configs: configs || [] }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "get": {
        if (!companyName) {
          return new Response(
            JSON.stringify({ error: "Company name is required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const config = await supabaseQuery(
          `ivr_configurations?company_name=eq.${encodeURIComponent(companyName)}&select=*,ivr_menu_options(id,digit,label,department_id,user_id)`
        );

        return new Response(
          JSON.stringify({ success: true, config: config?.[0] || null }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "save": {
        if (!companyName) {
          return new Response(
            JSON.stringify({ error: "Company name is required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Check if config exists
        const existing = await supabaseQuery(
          `ivr_configurations?company_name=eq.${encodeURIComponent(companyName)}&select=id`
        );

        let ivrConfigId: string;

        if (existing && existing.length > 0) {
          // Update existing config
          ivrConfigId = existing[0].id;
          await supabaseQuery(
            `ivr_configurations?id=eq.${ivrConfigId}`,
            "PATCH",
            {
              phone_number_id: phoneNumberId || null,
              greeting_message: greetingMessage,
              voice: voice || 'Polly.Amy-Neural',
              updated_at: new Date().toISOString(),
            }
          );
        } else {
          // Create new config
          const result = await supabaseQuery("ivr_configurations", "POST", {
            company_name: companyName,
            phone_number_id: phoneNumberId || null,
            greeting_message: greetingMessage,
            voice: voice || 'Polly.Amy-Neural',
          });
          ivrConfigId = result?.[0]?.id;
        }

        if (!ivrConfigId) {
          throw new Error("Failed to create/update IVR configuration");
        }

        // Delete existing menu options
        try {
          await supabaseQuery(
            `ivr_menu_options?ivr_config_id=eq.${ivrConfigId}`,
            "DELETE"
          );
        } catch (e) {
          // Ignore if no options exist
          console.log("No existing menu options to delete");
        }

        // Insert new menu options (batch insert)
        if (menuOptions && menuOptions.length > 0) {
          const optionsToInsert = menuOptions.map((opt: any) => ({
            ivr_config_id: ivrConfigId,
            digit: opt.digit,
            label: opt.label,
            department_id: opt.department_id || null,
            user_id: opt.user_id || null,
          }));

          await supabaseQuery("ivr_menu_options", "POST", optionsToInsert);
        }

        // Update phone number's company_name if assigned
        if (phoneNumberId) {
          await supabaseQuery(
            `phone_numbers?id=eq.${phoneNumberId}`,
            "PATCH",
            { company_name: companyName }
          );
        }

        return new Response(
          JSON.stringify({ success: true, configId: ivrConfigId }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "delete": {
        if (!configId) {
          return new Response(
            JSON.stringify({ error: "Config ID is required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Delete menu options first
        await supabaseQuery(
          `ivr_menu_options?ivr_config_id=eq.${configId}`,
          "DELETE"
        );

        // Delete config
        await supabaseQuery(
          `ivr_configurations?id=eq.${configId}`,
          "DELETE"
        );

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: "Invalid action" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  } catch (error: any) {
    console.error("Admin IVR error:", error.message, error.stack);
    return new Response(
      JSON.stringify({ error: error.message, details: error.stack }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
