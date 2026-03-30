import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Simple hash function for password comparison
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "greencaller_salt_2024");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// Generate secure token
function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, "0")).join("");
}

async function supabaseQuery(query: string, method: string = "GET", body?: any) {
  const url = `${SUPABASE_URL}/rest/v1/${query}`;
  const options: RequestInit = {
    method,
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=representation" : "return=minimal",
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
    const { action, email, password, token, fullName } = await req.json();

    switch (action) {
      case "login": {
        if (!email || !password) {
          return new Response(
            JSON.stringify({ error: "Email and password required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Find admin user
        const admins = await supabaseQuery(
          `admin_users?email=eq.${encodeURIComponent(email)}&is_active=eq.true&select=*`
        );

        if (!admins || admins.length === 0) {
          return new Response(
            JSON.stringify({ error: "Invalid credentials" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const admin = admins[0];
        const hashedPassword = await hashPassword(password);

        if (admin.password_hash !== hashedPassword) {
          return new Response(
            JSON.stringify({ error: "Invalid credentials" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Create session
        const sessionToken = generateToken();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

        await supabaseQuery("admin_sessions", "POST", {
          admin_id: admin.id,
          token: sessionToken,
          expires_at: expiresAt,
        });

        // Update last login
        await supabaseQuery(
          `admin_users?id=eq.${admin.id}`,
          "PATCH",
          { last_login: new Date().toISOString() }
        );

        return new Response(
          JSON.stringify({ 
            success: true, 
            token: sessionToken,
            admin: { full_name: admin.full_name, email: admin.email }
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "validate": {
        if (!token) {
          return new Response(
            JSON.stringify({ valid: false }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Find session
        const sessions = await supabaseQuery(
          `admin_sessions?token=eq.${encodeURIComponent(token)}&select=*,admin_users(*)`
        );

        if (!sessions || sessions.length === 0) {
          return new Response(
            JSON.stringify({ valid: false }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const session = sessions[0];
        const expiresAt = new Date(session.expires_at);

        if (expiresAt < new Date()) {
          // Delete expired session
          await supabaseQuery(`admin_sessions?id=eq.${session.id}`, "DELETE");
          return new Response(
            JSON.stringify({ valid: false }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({ 
            valid: true,
            admin: { 
              full_name: session.admin_users?.full_name,
              email: session.admin_users?.email
            }
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "logout": {
        if (token) {
          await supabaseQuery(`admin_sessions?token=eq.${encodeURIComponent(token)}`, "DELETE");
        }
        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "create": {
        // Create new admin user (for initial setup)
        if (!email || !password || !fullName) {
          return new Response(
            JSON.stringify({ error: "Email, password, and fullName required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const hashedPassword = await hashPassword(password);

        const result = await supabaseQuery("admin_users", "POST", {
          email,
          password_hash: hashedPassword,
          full_name: fullName,
        });

        return new Response(
          JSON.stringify({ success: true, admin: result?.[0] }),
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
    console.error("Admin auth error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});