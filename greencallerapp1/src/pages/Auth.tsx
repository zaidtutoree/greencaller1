import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import logo from "@/assets/greencaller-full-logo.png";

const Auth = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      toast({ title: "Welcome back!" });
      navigate("/dashboard");
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      {/* White Header Bar */}
      <header className="bg-white border-b border-border/40 px-6 py-3">
        <img src={logo} alt="Greencaller" className="h-10 w-auto" />
      </header>

      {/* Main Content - Centered Card */}
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="bg-white rounded-lg border border-border/60 shadow-sm p-8 md:p-10">
            <div className="mb-8">
              <h1 className="text-2xl font-semibold text-foreground mb-2">
                Log in to Greencaller
              </h1>
              <p className="text-muted-foreground text-sm">
                Enter your credentials to access your account.
              </p>
            </div>

            <form onSubmit={handleAuth} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-medium text-foreground">
                  Email <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="Enter email address"
                  className="h-11 bg-white border-border focus:border-primary focus:ring-primary"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-medium text-foreground">
                  Password <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="Enter your password"
                  minLength={6}
                  className="h-11 bg-white border-border focus:border-primary focus:ring-primary"
                />
              </div>

              <Button 
                type="submit" 
                className="w-full h-11 text-sm font-medium mt-6" 
                disabled={loading}
              >
                {loading ? "Please wait..." : "Continue"}
              </Button>
            </form>
          </div>

          <p className="text-center text-xs text-muted-foreground mt-6">
            By continuing, you agree to Greencaller's Terms of Service and Privacy Policy.
          </p>
        </div>
      </main>
    </div>
  );
};

export default Auth;
