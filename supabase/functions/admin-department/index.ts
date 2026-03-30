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
    const adminToken = req.headers.get("x-admin-token");
    if (!adminToken) {
      return new Response(
        JSON.stringify({ error: "Admin token required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { valid, adminId } = await validateAdminToken(adminToken);
    if (!valid) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired admin token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { action, departmentId, name, companyName, phoneNumberId, userId } = await req.json();

    switch (action) {
      case "list": {
        const departments = await supabaseQuery("departments?select=*&order=created_at.desc");
        return new Response(
          JSON.stringify({ success: true, departments: departments || [] }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "create": {
        if (!name || !companyName) {
          return new Response(
            JSON.stringify({ error: "Name and company name are required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const result = await supabaseQuery("departments", "POST", {
          name: name.trim(),
          company_name: companyName.trim(),
          created_by: adminId,
        });

        return new Response(
          JSON.stringify({ success: true, department: result?.[0] }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "assign-phone": {
        if (!departmentId) {
          return new Response(
            JSON.stringify({ error: "Department ID is required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        await supabaseQuery(
          `departments?id=eq.${departmentId}`,
          "PATCH",
          { phone_number_id: phoneNumberId || null }
        );

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "list-members": {
        if (!departmentId) {
          return new Response(
            JSON.stringify({ error: "Department ID is required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Get all members of this department with their profile info
        const members = await supabaseQuery(
          `department_members?department_id=eq.${departmentId}&select=id,user_id,added_at,profiles(id,full_name,email)`
        );

        return new Response(
          JSON.stringify({ success: true, members: members || [] }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "assign-user": {
        if (!departmentId || !userId) {
          return new Response(
            JSON.stringify({ error: "Department ID and User ID are required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Check if user is already assigned to this department
        const existing = await supabaseQuery(
          `department_members?department_id=eq.${departmentId}&user_id=eq.${userId}&select=id`
        );

        if (existing && existing.length > 0) {
          return new Response(
            JSON.stringify({ error: "User is already assigned to this department" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Add user to department
        const result = await supabaseQuery("department_members", "POST", {
          department_id: departmentId,
          user_id: userId,
        });

        return new Response(
          JSON.stringify({ success: true, member: result?.[0] }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "remove-user": {
        if (!departmentId || !userId) {
          return new Response(
            JSON.stringify({ error: "Department ID and User ID are required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        await supabaseQuery(
          `department_members?department_id=eq.${departmentId}&user_id=eq.${userId}`,
          "DELETE"
        );

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "get-user-departments": {
        if (!userId) {
          return new Response(
            JSON.stringify({ error: "User ID is required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Get all departments this user is assigned to
        const memberships = await supabaseQuery(
          `department_members?user_id=eq.${userId}&select=department_id,departments(*)`
        );

        const departments = memberships?.map((m: any) => m.departments).filter(Boolean) || [];

        return new Response(
          JSON.stringify({ success: true, departments }),
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
    console.error("Admin department error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
