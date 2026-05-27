"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import Link from "next/link";

import { api } from "@/lib/api";

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", password: "", full_name: "" });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/auth/register", form);
      toast.success("account created — log in");
      router.push("/login");
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Create account</h1>
        <div className="space-y-2">
          <label className="label">Full name</label>
          <input className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </div>
        <div className="space-y-2">
          <label className="label">Email</label>
          <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </div>
        <div className="space-y-2">
          <label className="label">Password (min 8)</label>
          <input className="input" type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </div>
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        <p className="text-sm text-muted-foreground text-center">
          Have an account? <Link className="text-primary hover:underline" href="/login">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
