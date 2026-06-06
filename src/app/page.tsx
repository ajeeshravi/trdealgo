"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    // The US trading app is the default entry point.
    router.replace("/us/dashboard");
  }, [router]);
  return null;
}
