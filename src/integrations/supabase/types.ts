export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      admin_sessions: {
        Row: {
          admin_id: string
          created_at: string
          expires_at: string
          id: string
          token: string
        }
        Insert: {
          admin_id: string
          created_at?: string
          expires_at: string
          id?: string
          token: string
        }
        Update: {
          admin_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_sessions_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "admin_users"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_users: {
        Row: {
          created_at: string
          email: string
          full_name: string
          id: string
          is_active: boolean
          last_login: string | null
          password_hash: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name: string
          id?: string
          is_active?: boolean
          last_login?: string | null
          password_hash: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean
          last_login?: string | null
          password_hash?: string
          updated_at?: string
        }
        Relationships: []
      }
      call_history: {
        Row: {
          billing_group: string | null
          call_sid: string | null
          cost: number | null
          created_at: string | null
          direction: string
          duration: number | null
          from_number: string
          id: string
          rate: number | null
          rate_type: string | null
          status: string | null
          to_number: string
          user_id: string | null
        }
        Insert: {
          billing_group?: string | null
          call_sid?: string | null
          cost?: number | null
          created_at?: string | null
          direction: string
          duration?: number | null
          from_number: string
          id?: string
          rate?: number | null
          rate_type?: string | null
          status?: string | null
          to_number: string
          user_id?: string | null
        }
        Update: {
          billing_group?: string | null
          call_sid?: string | null
          cost?: number | null
          created_at?: string | null
          direction?: string
          duration?: number | null
          from_number?: string
          id?: string
          rate?: number | null
          rate_type?: string | null
          status?: string | null
          to_number?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_history_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      call_queue: {
        Row: {
          call_sid: string
          company_name: string
          connected_at: string | null
          created_at: string | null
          department_id: string | null
          from_number: string
          id: string
          picked_up_at: string | null
          picked_up_by: string | null
          status: string | null
          to_number: string
        }
        Insert: {
          call_sid: string
          company_name: string
          connected_at?: string | null
          created_at?: string | null
          department_id?: string | null
          from_number: string
          id?: string
          picked_up_at?: string | null
          picked_up_by?: string | null
          status?: string | null
          to_number: string
        }
        Update: {
          call_sid?: string
          company_name?: string
          connected_at?: string | null
          created_at?: string | null
          department_id?: string | null
          from_number?: string
          id?: string
          picked_up_at?: string | null
          picked_up_by?: string | null
          status?: string | null
          to_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_queue_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_queue_picked_up_by_fkey"
            columns: ["picked_up_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      call_recordings: {
        Row: {
          call_sid: string
          created_at: string | null
          direction: string
          duration: number | null
          from_number: string
          id: string
          recording_sid: string
          recording_url: string
          to_number: string
          transcription: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          call_sid: string
          created_at?: string | null
          direction: string
          duration?: number | null
          from_number: string
          id?: string
          recording_sid: string
          recording_url: string
          to_number: string
          transcription?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          call_sid?: string
          created_at?: string | null
          direction?: string
          duration?: number | null
          from_number?: string
          id?: string
          recording_sid?: string
          recording_url?: string
          to_number?: string
          transcription?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_recordings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      department_members: {
        Row: {
          added_at: string | null
          department_id: string
          id: string
          user_id: string
        }
        Insert: {
          added_at?: string | null
          department_id: string
          id?: string
          user_id: string
        }
        Update: {
          added_at?: string | null
          department_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "department_members_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          company_name: string
          created_at: string | null
          created_by: string | null
          description: string | null
          id: string
          name: string
          phone_number_id: string | null
          updated_at: string | null
        }
        Insert: {
          company_name: string
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          phone_number_id?: string | null
          updated_at?: string | null
        }
        Update: {
          company_name?: string
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          phone_number_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "departments_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          },
        ]
      }
      ivr_configurations: {
        Row: {
          company_name: string
          created_at: string | null
          greeting_message: string
          id: string
          phone_number_id: string | null
          updated_at: string | null
          voice: string
        }
        Insert: {
          company_name: string
          created_at?: string | null
          greeting_message?: string
          id?: string
          phone_number_id?: string | null
          updated_at?: string | null
          voice?: string
        }
        Update: {
          company_name?: string
          created_at?: string | null
          greeting_message?: string
          id?: string
          phone_number_id?: string | null
          updated_at?: string | null
          voice?: string
        }
        Relationships: [
          {
            foreignKeyName: "ivr_configurations_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          },
        ]
      }
      ivr_menu_options: {
        Row: {
          created_at: string | null
          department_id: string | null
          digit: string
          id: string
          ivr_config_id: string | null
          label: string
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          department_id?: string | null
          digit: string
          id?: string
          ivr_config_id?: string | null
          label: string
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          department_id?: string | null
          digit?: string
          id?: string
          ivr_config_id?: string | null
          label?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ivr_menu_options_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ivr_menu_options_ivr_config_id_fkey"
            columns: ["ivr_config_id"]
            isOneToOne: false
            referencedRelation: "ivr_configurations"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          created_at: string | null
          direction: string
          from_number: string
          id: string
          message_body: string
          status: string | null
          to_number: string
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          direction: string
          from_number: string
          id?: string
          message_body: string
          status?: string | null
          to_number: string
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          direction?: string
          from_number?: string
          id?: string
          message_body?: string
          status?: string | null
          to_number?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      phone_numbers: {
        Row: {
          assigned_to: string | null
          company_name: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          phone_number: string
          provider: string
          updated_at: string | null
        }
        Insert: {
          assigned_to?: string | null
          company_name?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          phone_number: string
          provider?: string
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string | null
          company_name?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          phone_number?: string
          provider?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "phone_numbers_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          active_subscription_id: string | null
          avatar_url: string | null
          can_make_calls: boolean
          company_name: string | null
          created_at: string | null
          email: string
          full_name: string
          id: string
          is_company_admin: boolean
          onesignal_player_id: string | null
          stripe_customer_id: string | null
          subscription_status: string | null
          updated_at: string | null
        }
        Insert: {
          account_type?: Database["public"]["Enums"]["account_type"]
          active_subscription_id?: string | null
          avatar_url?: string | null
          can_make_calls?: boolean
          company_name?: string | null
          created_at?: string | null
          email: string
          full_name: string
          id: string
          is_company_admin?: boolean
          onesignal_player_id?: string | null
          stripe_customer_id?: string | null
          subscription_status?: string | null
          updated_at?: string | null
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          active_subscription_id?: string | null
          avatar_url?: string | null
          can_make_calls?: boolean
          company_name?: string | null
          created_at?: string | null
          email?: string
          full_name?: string
          id?: string
          is_company_admin?: boolean
          onesignal_player_id?: string | null
          stripe_customer_id?: string | null
          subscription_status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_active_subscription_id_fkey"
            columns: ["active_subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      team_messages: {
        Row: {
          created_at: string
          from_user_id: string
          id: string
          message_body: string
          read: boolean
          to_user_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          from_user_id: string
          id?: string
          message_body: string
          read?: boolean
          to_user_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          from_user_id?: string
          id?: string
          message_body?: string
          read?: boolean
          to_user_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_messages_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_messages_to_user_id_fkey"
            columns: ["to_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      telnyx_call_bridges: {
        Row: {
          created_at: string
          from_number: string
          id: string
          pstn_call_control_id: string
          status: string
          to_number: string
          updated_at: string
          user_id: string
          webrtc_call_control_id: string
        }
        Insert: {
          created_at?: string
          from_number: string
          id?: string
          pstn_call_control_id: string
          status?: string
          to_number: string
          updated_at?: string
          user_id: string
          webrtc_call_control_id: string
        }
        Update: {
          created_at?: string
          from_number?: string
          id?: string
          pstn_call_control_id?: string
          status?: string
          to_number?: string
          updated_at?: string
          user_id?: string
          webrtc_call_control_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "telnyx_call_bridges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      telnyx_webrtc_registrations: {
        Row: {
          expires_at: string | null
          sip_username: string
          updated_at: string
          user_id: string
        }
        Insert: {
          expires_at?: string | null
          sip_username: string
          updated_at?: string
          user_id: string
        }
        Update: {
          expires_at?: string | null
          sip_username?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "telnyx_webrtc_registrations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          id: string
          created_at: string
          trial_period_days: number
          amount_pence: number
          stripe_product_id: string | null
          stripe_recurring_price_id: string | null
          stripe_overage_price_id: string | null
          lead_user_id: string
          invite_email_to: string
          invite_email_from: string
          status: string
          stripe_subscription_id: string | null
          stripe_subscription_item_id: string | null
          checkout_url: string | null
          invite_sent_at: string | null
        }
        Insert: {
          id?: string
          created_at?: string
          trial_period_days?: number
          amount_pence: number
          stripe_product_id?: string | null
          stripe_recurring_price_id?: string | null
          stripe_overage_price_id?: string | null
          lead_user_id: string
          invite_email_to: string
          invite_email_from: string
          status?: string
          stripe_subscription_id?: string | null
          stripe_subscription_item_id?: string | null
          checkout_url?: string | null
          invite_sent_at?: string | null
        }
        Update: {
          id?: string
          created_at?: string
          trial_period_days?: number
          amount_pence?: number
          stripe_product_id?: string | null
          stripe_recurring_price_id?: string | null
          stripe_overage_price_id?: string | null
          lead_user_id?: string
          invite_email_to?: string
          invite_email_from?: string
          status?: string
          stripe_subscription_id?: string | null
          stripe_subscription_item_id?: string | null
          checkout_url?: string | null
          invite_sent_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_lead_user_id_fkey"
            columns: ["lead_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_users: {
        Row: {
          id: string
          subscription_id: string
          user_id: string
          joined_at: string
        }
        Insert: {
          id?: string
          subscription_id: string
          user_id: string
          joined_at?: string
        }
        Update: {
          id?: string
          subscription_id?: string
          user_id?: string
          joined_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_users_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_users_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      voicemails: {
        Row: {
          created_at: string | null
          duration: number | null
          from_number: string
          id: string
          recording_sid: string
          recording_url: string
          status: string | null
          to_number: string
          transcription: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          duration?: number | null
          from_number: string
          id?: string
          recording_sid: string
          recording_url: string
          status?: string | null
          to_number: string
          transcription?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          duration?: number | null
          from_number?: string
          id?: string
          recording_sid?: string
          recording_url?: string
          status?: string | null
          to_number?: string
          transcription?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      account_type: "basic" | "premium" | "enterprise"
      app_role: "admin" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_type: ["basic", "premium", "enterprise"],
      app_role: ["admin", "user"],
    },
  },
} as const
