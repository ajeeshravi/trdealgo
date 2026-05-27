"use client";
import useSWR from "swr";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Plus, Pin, PinOff, XCircle, Plug } from "lucide-react";
import { api } from "@/lib/api";
import { fmtExpiry, fmtINR, prettyError } from "@/lib/fmt";
import { cn } from "@/lib/utils";
import { useMarketPollInterval } from "@/lib/marketHours";
import { useConfirm } from "@/components/ConfirmDialog";
import { ExchangeSymbolPicker } from "@/components/ExchangeSymbolPicker";
import { Pagination, usePagination } from "@/components/Pagination";
import { StatePill } from "@/components/StatePill";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { SymbolColumnsRow } from "@/components/SymbolColumns";

type Order = SymbolColumnsRow & {
  id: string;
  broker_account_id: string | null;
  internal_symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  filled_qty: number;
  order_type: string;
  product: string;
  variety?: string;
  price?: number | null;
  trigger_price?: number | null;
  avg_price?: number | null;
  state: string;
  broker_order_id?: string | null;
  last_error?: string | null;
  sent_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
  /** When set, this row isn't a broker order — it's a client-side
   *  ManagedTrigger waiting for the LTP to cross. Render distinctly:
   *  no broker_order_id column (won't have one until the trigger fires
   *  and an actual order is placed), state pill comes from the trigger
   *  not the order, cancel routes through `/triggers/{id}` not
   *  `/orders/{id}`. */
  managed_trigger_id?: string | null;
  managed_trigger_state?: string | null;
};

type BrokerAccount = {
  id: string;
  broker: string;
  client_id: string;
  label?: string | null;
  is_paper: boolean;
};

const CANCELLABLE_STATES = new Set(["NEW", "SENT", "OPEN", "PARTIAL"]);

function displayName(o: { trading_symbol?: string; underlying?: string | null }): string {
  return o.trading_symbol || o.underlying || "—";
}

/** Compact date+time for the table cell: "14 May 10:23:47". */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const day = String(d.getDate()).padStart(2, "0");
  const mon = d.toLocaleString(undefined, { month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour12: false });
  return `${day} ${mon} ${time}`;
}


const fetcher = (u: string) => api.get(u).then((r) => r.data);

const PIN_STORAGE_KEY = "order-dialog-pinned";

type FormState = {
  broker_account_id: string;
  internal_symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  order_type: string;
  product: string;
  variety: string;
  price: string;
  trigger_price: string;
};

const EMPTY_FORM: FormState = {
  broker_account_id: "",
  internal_symbol: "",
  side: "BUY",
  qty: 1,
  order_type: "MARKET",
  product: "MIS",
  variety: "REGULAR",
  price: "",
  trigger_price: "",
};

export default function OrdersPage() {
  // Order state can change on any exchange we trade — use the union
  // session (09:00–23:30 IST Mon-Fri) so MCX/CDS desks keep ticking
  // after equity close, but Saturday/Sunday/late-night the poll stops.
  const ordersPoll = useMarketPollInterval(10000, "ANY");
  const { data: orders, mutate } = useSWR<Order[]>("/orders?limit=200", fetcher, { refreshInterval: ordersPoll });
  const { data: brokers } = useSWR<BrokerAccount[]>("/brokers", fetcher);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const confirm = useConfirm();

  const rows: Order[] = orders || [];
  const { page, pageSize, pageRows, setPage, setPageSize } = usePagination(rows, 20);

  const brokerById = useMemo(() => {
    const m = new Map<string, BrokerAccount>();
    (brokers || []).forEach((b) => m.set(b.id, b));
    return m;
  }, [brokers]);

  const selectedRow = useMemo(
    () => (selectedRowId ? rows.find((r) => r.id === selectedRowId) || null : null),
    [selectedRowId, rows],
  );

  async function cancelOrder(o: Order) {
    // Managed-trigger rows aren't broker orders, so /orders/{id}
    // DELETE doesn't apply. Route to the trigger-cancel endpoint and
    // let it handle the cascade (an ENTRY cancels its SL/Target
    // children too — see TriggerService.cancel).
    if (o.managed_trigger_id) {
      const label = displayName(o);
      const ok = await confirm({
        title: `Cancel trigger for ${label}?`,
        message:
          `Drops the watching trigger at ₹${Number(o.trigger_price ?? 0).toFixed(2)}. ` +
          `No broker order will be placed if the LTP later crosses. ` +
          `If this is an ENTRY trigger, its SL and Target are also cancelled.`,
        confirmLabel: "Cancel trigger",
        cancelLabel: "Keep",
        variant: "warning",
      });
      if (!ok) return;
      try {
        await api.delete(`/triggers/${o.managed_trigger_id}`);
        toast.success("trigger cancelled");
        mutate();
      } catch (e: any) {
        toast.error(e?.response?.data?.error?.message || "cancel failed");
      }
      return;
    }
    if (!CANCELLABLE_STATES.has(o.state)) {
      toast.error(`cannot cancel — already ${o.state.toLowerCase()}`);
      return;
    }
    const label = displayName(o);
    const acct = o.broker_account_id ? brokerById.get(o.broker_account_id) : null;
    const acctLabel = acct
      ? `${acct.broker} · ${acct.client_id}${acct.is_paper ? " (PAPER)" : ""}`
      : "this broker";
    const ok = await confirm({
      title: `Cancel ${label}?`,
      message: `Cancels the ${o.side} order for ${o.qty} ${label} on ${acctLabel}. Any filled portion remains.`,
      confirmLabel: "Cancel order",
      cancelLabel: "Keep order",
      variant: acct?.is_paper ? "warning" : "danger",
    });
    if (!ok) return;
    try {
      await api.delete(`/orders/${o.id}`);
      toast.success("order cancelled");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "cancel failed");
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Orders</h1>
          <p className="text-sm text-muted-foreground font-mono">
            {rows.length} order{rows.length === 1 ? "" : "s"}
          </p>
        </div>
        <button className="btn-primary inline-flex items-center gap-1.5" onClick={() => setDialogOpen(true)}>
          <Plus className="w-4 h-4" />
          New order
        </button>
      </header>

      <ManualOrderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        brokers={brokers || []}
        onSubmitted={() => mutate()}
      />

      <div className="card">
        {rows.length > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={rows.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            className="mb-2 border-b border-border/50"
          />
        )}
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Exchange</th>
              <th>Symbol</th>
              <th>Broker</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Filled</th>
              <th>Type</th>
              <th>Price</th>
              <th>Avg</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((o) => {
              const acct = o.broker_account_id ? brokerById.get(o.broker_account_id) : null;
              return (
                <tr
                  key={o.id}
                  onClick={() => setSelectedRowId(o.id)}
                  className="hover:bg-accent/30 transition-colors cursor-pointer"
                >
                  <td className="font-mono text-xs whitespace-nowrap">{fmtDateTime(o.created_at)}</td>
                  <td>{o.exchange || "—"}</td>
                  <td className="font-mono">{displayName(o)}</td>
                  <td>
                    {acct ? (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs">
                          {acct.broker} · {acct.client_id}
                        </span>
                        {acct.is_paper && (
                          <span className="pill bg-warning/20 text-warning text-[9px]">PAPER</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">—</span>
                    )}
                  </td>
                  <td className={o.side === "BUY" ? "text-profit font-mono font-semibold" : "text-loss font-mono font-semibold"}>
                    {o.side}
                  </td>
                  <td className="font-mono">{o.qty}</td>
                  <td className="font-mono">{o.filled_qty}</td>
                  <td>{o.order_type}</td>
                  <td className="font-mono">{fmtINR(o.price)}</td>
                  <td className="font-mono">{fmtINR(o.avg_price)}</td>
                  <td>
                    {o.managed_trigger_id ? (
                      <span
                        className="pill bg-primary/15 text-primary font-mono"
                        title={
                          `Client-side trigger — the broker order is placed only when ` +
                          `LTP crosses ${fmtINR(o.trigger_price ?? 0)}. State: ${o.managed_trigger_state ?? "ARMED"}.`
                        }
                      >
                        {o.managed_trigger_state ?? "ARMED"}
                      </span>
                    ) : (
                      <StatePill state={o.state} />
                    )}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={11} className="text-center text-muted-foreground py-4">
                  No orders yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {rows.length > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={rows.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        )}
      </div>

      <Dialog open={!!selectedRow} onOpenChange={(o) => !o && setSelectedRowId(null)}>
        <DialogContent className="max-w-lg">
          {selectedRow && (
            <OrderDetail
              o={selectedRow}
              broker={selectedRow.broker_account_id ? brokerById.get(selectedRow.broker_account_id) : null}
              onCancelOrder={async () => {
                const row = selectedRow;
                setSelectedRowId(null);
                if (row) await cancelOrder(row);
              }}
              onClose={() => setSelectedRowId(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ====================================================================
// Order detail panel — full read-out + Cancel action
// ====================================================================
function OrderDetail({
  o,
  broker,
  onCancelOrder,
  onClose,
}: {
  o: Order;
  broker: BrokerAccount | null | undefined;
  onCancelOrder: () => void | Promise<void>;
  onClose: () => void;
}) {
  const isPaper = !!broker?.is_paper;
  const isFno = !!(o.expiry || o.strike != null || o.option_type);
  const cancellable = CANCELLABLE_STATES.has(o.state);

  return (
    <>
      <DialogHeader className="sr-only">
        <DialogTitle>
          {displayName(o)} order on {broker ? `${broker.broker} · ${broker.client_id}` : "unknown broker"}
        </DialogTitle>
        <DialogDescription>Order detail</DialogDescription>
      </DialogHeader>

      {/* Broker banner */}
      <div className="rounded-md border border-border bg-accent/40 p-3 pr-12">
        {broker ? (
          <div className="flex items-start gap-3">
            <div className={cn(
              "shrink-0 w-9 h-9 rounded-md flex items-center justify-center",
              isPaper ? "bg-warning/15 text-warning" : "bg-primary/15 text-primary",
            )}>
              <Plug className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="text-sm font-semibold leading-tight">{broker.broker}</div>
              <div className="text-xs font-mono text-muted-foreground">
                {broker.client_id}
                {broker.label && <span> · {broker.label}</span>}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {isPaper ? "Paper trading account" : "Live trading account"}
              </div>
            </div>
            <div className="shrink-0">
              <StatePill state={o.state} />
            </div>
          </div>
        ) : (
          <div className="text-xs text-loss">
            Broker not on record — restart backend so /orders returns broker_account_id.
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm mt-5">
        {o.trading_symbol && (
          <DetailRow label="Trading symbol" value={o.trading_symbol} mono />
        )}
        {isFno && o.underlying && o.underlying !== o.trading_symbol && (
          <DetailRow label="Underlying" value={o.underlying} mono />
        )}
        <DetailRow label="Exchange" value={o.exchange || "—"} />
        {o.segment && <DetailRow label="Segment" value={o.segment} />}
        {o.option_type && <DetailRow label="Option type" value={o.option_type} />}
        {o.expiry && <DetailRow label="Expiry" value={fmtExpiry(o.expiry)} mono />}
        {o.strike != null && <DetailRow label="Strike" value={fmtINR(o.strike)} mono />}
        <DetailRow
          label="Side"
          value={o.side}
          mono
          className={o.side === "BUY" ? "text-profit font-semibold" : "text-loss font-semibold"}
        />
        <DetailRow label="Quantity" value={String(o.qty)} mono />
        <DetailRow label="Filled" value={String(o.filled_qty)} mono />
        <DetailRow label="Order type" value={o.order_type} />
        <DetailRow label="Product" value={o.product} />
        {o.variety && <DetailRow label="Variety" value={o.variety} />}
        {o.price != null && <DetailRow label="Price" value={fmtINR(o.price)} mono />}
        {o.trigger_price != null && (
          <DetailRow label="Trigger price" value={fmtINR(o.trigger_price)} mono />
        )}
        {o.avg_price != null && <DetailRow label="Avg fill price" value={fmtINR(o.avg_price)} mono />}
        {o.broker_order_id && (
          <DetailRow label="Broker order ID" value={o.broker_order_id} mono />
        )}
        {o.created_at && (
          <DetailRow label="Placed at" value={new Date(o.created_at).toLocaleString()} mono />
        )}
        {o.sent_at && (
          <DetailRow label="Sent at" value={new Date(o.sent_at).toLocaleString()} mono />
        )}
        {o.completed_at && (
          <DetailRow label="Completed at" value={new Date(o.completed_at).toLocaleString()} mono />
        )}
      </div>

      {o.last_error && (
        <div className="rounded-md border border-loss/40 bg-loss/10 p-2.5 text-xs text-loss mt-4">
          <span className="font-semibold">ERROR :</span> {prettyError(o.last_error)}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-4 border-t border-border mt-5">
        <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
        <button
          type="button"
          className="btn-danger inline-flex items-center gap-1.5"
          onClick={onCancelOrder}
          disabled={!cancellable || !o.broker_account_id}
          title={
            !o.broker_account_id
              ? "broker missing"
              : !cancellable
                ? `Already ${o.state.toLowerCase()}`
                : "Cancel this order"
          }
        >
          <XCircle className="w-4 h-4" />
          Cancel order
        </button>
      </div>
    </>
  );
}

function DetailRow({
  label, value, mono, className,
}: { label: string; value: string; mono?: boolean; className?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={cn("mt-0.5", mono && "font-mono", className)}>{value}</div>
    </div>
  );
}

// ====================================================================
// Manual order dialog — pinnable
// ====================================================================
function ManualOrderDialog({
  open,
  onOpenChange,
  brokers,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  brokers: any[];
  onSubmitted: () => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);

  // Restore pinned state from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setPinned(localStorage.getItem(PIN_STORAGE_KEY) === "1");
  }, []);

  function togglePin() {
    setPinned((p) => {
      const next = !p;
      try { localStorage.setItem(PIN_STORAGE_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.internal_symbol) {
      toast.error("pick a symbol");
      return;
    }
    setBusy(true);
    try {
      const payload: any = {
        broker_account_id: form.broker_account_id,
        internal_symbol: form.internal_symbol,
        side: form.side,
        qty: Number(form.qty),
        order_type: form.order_type,
        product: form.product,
        variety: form.variety,
      };
      if (form.price) payload.price = Number(form.price);
      if (form.trigger_price) payload.trigger_price = Number(form.trigger_price);
      await api.post("/orders", payload);
      toast.success("order submitted");
      onSubmitted();
      if (pinned) {
        // Reset symbol-side details so the user can place the next order quickly,
        // but keep the broker selection and side defaults.
        setForm((f) => ({
          ...f,
          internal_symbol: "",
          qty: 1,
          price: "",
          trigger_price: "",
        }));
      } else {
        onOpenChange(false);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Pin toggle, sitting just to the left of the built-in close X */}
        <button
          type="button"
          onClick={togglePin}
          aria-label={pinned ? "Unpin — close after submit" : "Pin — keep open after submit"}
          title={pinned ? "Pinned: stays open after submit" : "Pin: keep open after submit"}
          className={cn(
            "absolute right-12 top-4 rounded-sm p-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
            pinned ? "text-primary" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {pinned ? <Pin className="h-4 w-4 fill-current" /> : <PinOff className="h-4 w-4" />}
        </button>

        <DialogHeader>
          <DialogTitle>New order</DialogTitle>
          <DialogDescription>
            {/* Manual order — fill the details and send to broker. */}
            {/* {pinned && <span className="ml-1 text-primary">Pinned — window stays open after submit.</span>} */}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="col-span-2 lg:col-span-4">
            <div className="label">Broker</div>
            <select
              className="input"
              value={form.broker_account_id}
              onChange={(e) => setForm({ ...form, broker_account_id: e.target.value })}
              required
            >
              <option value="">Select broker</option>
              {brokers.map((b: any) => (
                <option key={b.id} value={b.id}>{b.broker} • {b.client_id}</option>
              ))}
            </select>
          </div>

          <div className="col-span-2 lg:col-span-4">
            <div className="label">Symbol</div>
            <ExchangeSymbolPicker
              value={form.internal_symbol}
              onChange={(v) => setForm({ ...form, internal_symbol: v })}
            />
          </div>

          <div>
            <div className="label">Side</div>
            <select className="input" value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value as "BUY" | "SELL" })}>
              <option>BUY</option><option>SELL</option>
            </select>
          </div>
          <div>
            <div className="label">Quantity</div>
            <input
              className="input" type="number" min={1} value={form.qty}
              onChange={(e) => setForm({ ...form, qty: Number(e.target.value) })}
            />
          </div>
          <div>
            <div className="label">Order type</div>
            <select className="input" value={form.order_type} onChange={(e) => setForm({ ...form, order_type: e.target.value })}>
              <option>MARKET</option><option>LIMIT</option><option>SL</option><option>SLM</option>
            </select>
          </div>
          <div>
            <div className="label">Product</div>
            <select className="input" value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })}>
              <option>MIS</option><option>CNC</option><option>NRML</option>
            </select>
          </div>
          <div className="col-span-2 lg:col-span-2">
            <div className="label">Variety</div>
            <select className="input" value={form.variety} onChange={(e) => setForm({ ...form, variety: e.target.value })}>
              <option>REGULAR</option><option>AMO</option><option>BRACKET</option><option>ICEBERG</option>
            </select>
          </div>
          <div>
            <div className="label">Price (LIMIT)</div>
            <input
              className="input" type="number" placeholder="—"
              value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })}
            />
          </div>
          <div>
            <div className="label">Trigger price (SL)</div>
            <input
              className="input" type="number" placeholder="—"
              value={form.trigger_price} onChange={(e) => setForm({ ...form, trigger_price: e.target.value })}
            />
          </div>

          <div className="col-span-2 lg:col-span-4 flex justify-end gap-2 pt-2 border-t border-border mt-2">
            <button type="button" className="btn-ghost" onClick={() => onOpenChange(false)}>Cancel</button>
            <button
              className={cn(
                "btn",
                form.side === "BUY"
                  ? "bg-profit text-primary-foreground hover:bg-profit/90"
                  : "bg-loss text-destructive-foreground hover:bg-loss/90",
              )}
              disabled={busy}
            >
              {busy ? "Sending…" : `${form.side === "BUY" ? "Buy" : "Sell"} · Send to broker`}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
