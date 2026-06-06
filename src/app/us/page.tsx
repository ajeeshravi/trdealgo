"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function UsIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/us/dashboard");
  }, [router]);
  return null;
}
