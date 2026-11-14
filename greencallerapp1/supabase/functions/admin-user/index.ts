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

    const body = await req.json();
    const { action } = body;

    switch (action) {
      case "delete": {
        const { userId } = body;
        if (!userId) {
          return new Response(
            JSON.stringify({ error: "User ID is required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Clean up all related records to avoid foreign key constraints
        const cleanupHeaders = {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        };

        // Delete call history
        await fetch(`${SUPABASE_URL}/rest/v1/call_history?user_id=eq.${userId}`, {
          method: "DELETE", headers: cleanupHeaders,
        });

        // Delete call recordings
        await fetch(`${SUPABASE_URL}/rest/v1/call_recordings?user_id=eq.${userId}`, {
          method: "DELETE", headers: cleanupHeaders,
        });

        // Delete WebRTC registrations
        await fetch(`${SUPABASE_URL}/rest/v1/telnyx_webrtc_registrations?user_id=eq.${userId}`, {
          method: "DELETE", headers: cleanupHeaders,
        });

        // Delete call bridges
        await fetch(`${SUPABASE_URL}/rest/v1/telnyx_call_bridges?user_id=eq.${userId}`, {
          method: "DELETE", headers: cleanupHeaders,
        });

        // Delete subscription user links
        await fetch(`${SUPABASE_URL}/rest/v1/subscription_users?user_id=eq.${userId}`, {
          method: "DELETE", headers: cleanupHeaders,
        });

        // Unassign phone numbers
        await fetch(`${SUPABASE_URL}/rest/v1/phone_numbers?assigned_to=eq.${userId}`, {
          method: "PATCH", headers: cleanupHeaders,
          body: JSON.stringify({ assigned_to: null }),
        });

        // Delete voicemails
        await fetch(`${SUPABASE_URL}/rest/v1/voicemails?user_id=eq.${userId}`, {
          method: "DELETE", headers: cleanupHeaders,
        });

        console.log("Cleaned up related records for user:", userId);

        // Delete user from auth.users using the Admin API
        const deleteResponse = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users/${userId}`,
          {
            method: "DELETE",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );

        if (!deleteResponse.ok) {
          const error = await deleteResponse.text();
          throw new Error(`Failed to delete user: ${error}`);
        }

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "create": {
        const { email, password, fullName } = body;
        if (!email || !password) {
          return new Response(
            JSON.stringify({ error: "Email and password are required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Create user via Admin API (auto-confirmed)
        const createResponse = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users`,
          {
            method: "POST",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              email,
              password,
              email_confirm: true,
              user_metadata: { full_name: fullName }
            })
          }
        );

        if (!createResponse.ok) {
          const error = await createResponse.text();
          throw new Error(`Failed to create user: ${error}`);
        }

        const createdUser = await createResponse.json();

        return new Response(
          JSON.stringify({ success: true, user: createdUser }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "update": {
        const { userId, updates } = body;
        if (!userId || !updates) {
          return new Response(
            JSON.stringify({ error: "User ID and updates are required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Update profiles table
        const updateResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`,
          {
            method: "PATCH",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(updates)
          }
        );

        if (!updateResponse.ok) {
          const error = await updateResponse.text();
          throw new Error(`Failed to update user: ${error}`);
        }

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
    console.error("Admin user error:", error);
    return new Response(
      JSON.stringify({
        error: error.message,
        stack: error.stack,
        details: typeof error === 'object' ? JSON.stringify(error) : String(error)
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
