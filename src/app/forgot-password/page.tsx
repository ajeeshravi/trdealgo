"use client";
import { useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";

import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devUrl, setDevUrl] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setDevUrl(null);
    try {
      const { data } = await api.post("/auth/forgot-password", { email });
      setSent(true);
      // In dev the backend returns a usable reset URL so you don't need SMTP.
      if (data?.dev_reset_url) setDevUrl(data.dev_reset_url);
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="card w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Reset your password</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Enter the email you used to register. We&apos;ll send you a reset link.
          </p>
        </div>

        {!sent ? (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <label className="label">Email</label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </form>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-panel2 p-3 text-sm">
              If <span className="font-mono">{email}</span> is registered, a reset link has been sent.
            </div>
            {devUrl && (
              <div className="rounded-md border border-yellow-700/50 bg-yellow-900/20 p-3 text-xs">
                <div className="text-yellow-400 font-medium mb-1">Dev mode</div>
                SMTP isn&apos;t configured, so here&apos;s the reset link directly:
                <br />
                <Link href={devUrl.replace("http://localhost:3000", "")} className="text-primary break-all hover:underline">
                  {devUrl}
                </Link>
              </div>
            )}
          </div>
        )}

        <div className="text-sm text-center">
          <Link className="text-muted-foreground hover:text-primary hover:underline" href="/login">
            Back to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
