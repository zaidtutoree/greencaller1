import { useState, useEffect, useRef } from "react";
import { Camera, Loader2, Save, CreditCard, AlertTriangle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface ProfileSettingsProps {
  userId?: string;
  onClose?: () => void;
}

export const ProfileSettings = ({ userId, onClose }: ProfileSettingsProps) => {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [subStatus, setSubStatus] = useState<string | null>(null);
  const [subCheckoutUrl, setSubCheckoutUrl] = useState<string | null>(null);
  const [isLeadUser, setIsLeadUser] = useState(false);

  useEffect(() => {
    const fetchProfile = async () => {
      if (!userId) return;

      setLoading(true);
      const { data: profile, error } = await supabase
        .from("profiles")
        .select("full_name, email, avatar_url, subscription_status, active_subscription_id")
        .eq("id", userId)
        .single();

      if (error) {
        console.error("Error fetching profile:", error);
        toast({
          title: "Error loading profile",
          description: error.message,
          variant: "destructive",
        });
      } else if (profile) {
        setFullName(profile.full_name || "");
        setEmail(profile.email || "");
        setAvatarUrl(profile.avatar_url);
        setSubStatus(profile.subscription_status || null);

        // Fetch subscription details if user has one
        if (profile.active_subscription_id) {
          const { data: sub } = await supabase
            .from("subscriptions")
            .select("lead_user_id, checkout_url")
            .eq("id", profile.active_subscription_id)
            .single();
          if (sub) {
            setIsLeadUser(sub.lead_user_id === userId);
            setSubCheckoutUrl(sub.checkout_url || null);
          }
        }
      }
      setLoading(false);
    };

    fetchProfile();
  }, [userId, toast]);

  const handleSaveProfile = async () => {
    if (!userId) return;

    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: fullName })
      .eq("id", userId);

    if (error) {
      toast({
        title: "Error saving profile",
        description: error.message,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Profile updated",
        description: "Your profile has been saved successfully.",
      });
    }
    setSaving(false);
  };

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !userId) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      toast({
        title: "Invalid file type",
        description: "Please upload an image file.",
        variant: "destructive",
      });
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Please upload an image smaller than 5MB.",
        variant: "destructive",
      });
      return;
    }

    setUploading(true);

    try {
      // Create a unique file name
      const fileExt = file.name.split(".").pop();
      const fileName = `${userId}/avatar.${fileExt}`;

      // Upload to storage
      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(fileName, file, { upsert: true });

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from("avatars")
        .getPublicUrl(fileName);

      // Add cache-busting query param
      const urlWithCacheBust = `${publicUrl}?t=${Date.now()}`;

      // Update profile with new avatar URL
      const { error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_url: urlWithCacheBust })
        .eq("id", userId);

      if (updateError) throw updateError;

      setAvatarUrl(urlWithCacheBust);
      toast({
        title: "Avatar updated",
        description: "Your profile picture has been updated.",
      });
    } catch (error: any) {
      console.error("Error uploading avatar:", error);
      toast({
        title: "Upload failed",
        description: error.message || "Failed to upload avatar.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const initials = fullName
    ? fullName.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)
    : email?.[0]?.toUpperCase() || "U";

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="font-display text-2xl">Profile Settings</CardTitle>
          <CardDescription>
            Update your personal information and profile picture
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar Section */}
          <div className="flex flex-col items-center gap-4">
            <div className="relative group">
              <Avatar className="w-24 h-24 border-4 border-primary/20">
                <AvatarImage src={avatarUrl || ""} alt={fullName} />
                <AvatarFallback className="bg-primary/10 text-primary text-2xl font-medium">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <button
                onClick={handleAvatarClick}
                disabled={uploading}
                className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer disabled:cursor-not-allowed"
              >
                {uploading ? (
                  <Loader2 className="w-6 h-6 text-white animate-spin" />
                ) : (
                  <Camera className="w-6 h-6 text-white" />
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Click to upload a new profile picture
            </p>
          </div>

          {/* Name Field */}
          <div className="space-y-2">
            <Label htmlFor="fullName">Full Name</Label>
            <Input
              id="fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Enter your full name"
              className="bg-background"
            />
          </div>

          {/* Email Field (Read-only) */}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              value={email}
              disabled
              className="bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Email cannot be changed
            </p>
          </div>

          {/* Subscription Status */}
          {subStatus && subStatus !== "none" && (
            <div className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center gap-2">
                {subStatus === "active" || subStatus === "trialing" ? (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-warning" />
                )}
                <Label className="font-semibold">Subscription</Label>
              </div>
              <p className="text-sm">
                Status:{" "}
                <span className={`font-medium ${
                  subStatus === "active" || subStatus === "trialing"
                    ? "text-green-500"
                    : subStatus === "past_due"
                    ? "text-orange-500"
                    : subStatus === "cancelled"
                    ? "text-red-500"
                    : "text-blue-500"
                }`}>
                  {subStatus.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                </span>
              </p>
              {isLeadUser && subStatus === "invite_sent" && subCheckoutUrl && (
                <Button
                  size="sm"
                  onClick={() => window.open(subCheckoutUrl, "_blank")}
                >
                  <CreditCard className="h-4 w-4 mr-2" />
                  Subscribe Now
                </Button>
              )}
              {!isLeadUser && ["invite_sent", "cancelled", "past_due"].includes(subStatus) && (
                <p className="text-xs text-muted-foreground">
                  Your account access depends on your organisation's subscription.
                </p>
              )}
            </div>
          )}

          {/* Save Button */}
          <div className="flex justify-end gap-3 pt-4">
            {onClose && (
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button onClick={handleSaveProfile} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save Changes
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
