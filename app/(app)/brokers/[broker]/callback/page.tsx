"use client";
/**
 * OAuth callback landing page for daily broker login.
 *
 * Brokers redirect here after the user logs in on their site.  We:
 *  1. Read the auth code from the URL (param name varies by broker).
 *  2. Resolve which BrokerAccount in our DB to log in:
 *      - if the broker echoed our `state` param, that's the account id
 *      - otherwise (Zerodha doesn't echo state), use the most recent account
 *        for this broker.
 *  3. Submit POST /brokers/{id}/login automatically.
 *  4. Redirect to /brokers with a success/error toast.
 */
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import toast from "react-hot-toast";
import { api } from "@/lib/api";

// Map: broker → URL param name returned by OAuth redirect → backend creds field name
const BROKER_PARAM_MAP: Record<string, { urlParam: string; bodyField: string }> = {
  ZERODHA: { urlParam: "request_token", bodyField: "request_token" },
  UPSTOX:  { urlParam: "code",          bodyField: "code" },
  FYERS:   { urlParam: "auth_code",     bodyField: "auth_code" },
};

export default function BrokerCallbackPage() {
  const router = useRouter();
  const params = useParams<{ broker: string }>();
  const search = useSearchParams();
  const brokerKey = (params?.broker || "").toUpperCase();
  const [status, setStatus] = useState<"working" | "ok" | "error">("working");
  const [message, setMessage] = useState<string>("Logging in…");
  // OAuth auth-codes are single-use. React 18 StrictMode re-runs effects on
  // mount in dev, which would POST the code twice — the second call hits the
  // broker with a now-consumed code and fails (Upstox: UDAPI100057).
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    const cfg = BROKER_PARAM_MAP[brokerKey];
    if (!cfg) {
      setStatus("error");
      setMessage(`Unknown broker '${brokerKey}'`);
      return;
    }

    // 1. Pull the auth code out of the URL (param name varies)
    const authValue = search.get(cfg.urlParam);
    const errorMsg = search.get("error_description") || search.get("error") || search.get("message");
    if (errorMsg && !authValue) {
      setStatus("error");
      setMessage(`Broker returned error: ${errorMsg}`);
      return;
    }
    if (!authValue) {
      setStatus("error");
      setMessage(
        `No '${cfg.urlParam}' in callback URL. Did the broker redirect here? ` +
        `Verify your redirect URI on the broker portal is set to this page.`,
      );
      return;
    }

    // 2. Pick the account to log in: prefer state, else fall back to broker lookup
    (async () => {
      try {
        let accountId: string | null = search.get("state");

        // Sanity-check: state should look like a UUID we issued.
        if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) {
          const { data } = await api.get(`/brokers/by-broker/${brokerKey}`);
          if (!Array.isArray(data) || data.length === 0) {
            setStatus("error");
            setMessage(`No ${brokerKey} account found in your platform. Add one in /brokers first.`);
            return;
          }
          accountId = data[0].id;
        }

        // 3. Submit the code to the backend
        const body: Record<string, string> = {};
        body[cfg.bodyField] = authValue;
        await api.post(`/brokers/${accountId}/login`, body);
        setStatus("ok");
        setMessage(`Connected ${brokerKey}. Redirecting…`);
        toast.success(`${brokerKey} login successful`);
        setTimeout(() => router.replace("/brokers"), 1200);
      } catch (e: any) {
        setStatus("error");
        setMessage(e?.response?.data?.error?.message || "Login failed");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerKey]);

  return (
    <div className="grid place-items-center min-h-[60vh]">
      <div className="card w-full max-w-md text-center space-y-3">
        <h1 className="text-xl font-semibold">{brokerKey} OAuth callback</h1>
        <div
          className={
            status === "working" ? "text-muted-foreground" :
            status === "ok"      ? "text-primary" :
                                    "text-danger"
          }
        >
          {message}
        </div>
        {status === "error" && (
          <button className="btn-outline mt-2" onClick={() => router.push("/brokers")}>
            Back to brokers
          </button>
        )}
      </div>
    </div>
  );
}
