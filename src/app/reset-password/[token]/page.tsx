"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

import { api } from "@/lib/api";

export default function ResetPasswordPage({ params }: { params: { token: string } }) {
  const router = useRouter();
  const { token } = params;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      toast.error("password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      toast.error("passwords don't match");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/reset-password", { token, new_password: password });
      toast.success("password updated — sign in with your new password");
      router.push("/login");
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "reset failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Choose a new password</h1>
          <p className="text-sm text-muted-foreground mt-1">Make it at least 8 characters.</p>
        </div>
        <div className="space-y-2">
          <label className="label">New password</label>
          <input
            className="input"
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <label className="label">Confirm new password</label>
          <input
            className="input"
            type="password"
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Saving…" : "Update password"}
        </button>
        <div className="text-sm text-center">
          <Link className="text-muted-foreground hover:text-primary hover:underline" href="/login">
            Back to sign in
          </Link>
        </div>
      </form>
    </main>
  );
}
