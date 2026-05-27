"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const t = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
    router.replace(t ? "/dashboard" : "/login");
  }, [router]);
  return null;
}
