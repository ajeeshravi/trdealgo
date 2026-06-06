"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiError, setTokens, usApi } from "@/lib/us/api";

export default function UsLoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "register") {
        await usApi.post("/auth/register", { email, password });
      }
      const { data } = await usApi.post("/auth/login", { email, password });
      if (data.mfa_required) {
        setError("MFA is enabled for this account — MFA flow not yet wired in this UI.");
        return;
      }
      setTokens(data.access_token, data.refresh_token);
      router.push("/us/dashboard");
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center">
            TradeAlgo US — {mode === "login" ? "Sign in" : "Create account"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email}
                onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required value={password}
                onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "…" : mode === "login" ? "Sign in" : "Register"}
            </Button>
          </form>
          <button
            onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}
            className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
          >
            {mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
