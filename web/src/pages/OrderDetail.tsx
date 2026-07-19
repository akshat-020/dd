import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, getToken } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { SkuCombobox } from "../components/SkuCombobox";
import type { InvoiceReference, Order, OrderAuditEntry, OrderLine, PickListItem, ProformaInvoice, Sku, StockCheckResult } from "../api/types";
import { availableUnits, compoundBreakdown } from "../lib/units";

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { hasRole, hasPermission, hasAnyPermission, hasAllPermissions } = useAuth();
  // Single permission gates the whole PATCH /orders/:id endpoint regardless
  // of order status (draft header, lines, Final Qty adjustments post-pick
  // all go through it) — "Finalize" is its own separate action/permission
  // (POST /orders/:id/finalize), since composing a new order and adjusting
  // an existing one are different workflows that can be granted apart.
  const canEdit = hasPermission("orders.editFinalized");
  const canFinalize = hasPermission("orders.createDraft");
  // Broadened beyond pricing.viewSalePrice: an account holding either
  // financial-document permission needs to see price on this order too,
  // even without general sale-price visibility — the server applies the
  // exact same rule (see canSeePrice in routes/orders.ts), so this only
  // ever mirrors what the API actually sends, never guesses ahead of it.
  const canSeePrice = hasAnyPermission("pricing.viewSalePrice", "pricing.manageInvoiceReference", "pricing.managePI");
  // Setting the order's canonical Unit Price inline is the same write as
  // the old "Save pricing" screen (PUT /orders/:id/pricing) — the fix for
  // the reported permission gap requires both document permissions, not
  // just one, since either one alone let an account write pricing data
  // whose downstream use (the other document type) it wasn't authorized
  // for. See requireAllPermissions in routes/pricing.ts.
  const canEditPrice = hasAllPermissions("pricing.manageInvoiceReference", "pricing.managePI");
  const canManageInvoiceReference = hasPermission("pricing.manageInvoiceReference");

  const [order, setOrder] = useState<Order | null>(null);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [stockCheck, setStockCheck] = useState<StockCheckResult[]>([]);
  const [pickList, setPickList] = useState<PickListItem[]>([]);
  const [auditEntries, setAuditEntries] = useState<OrderAuditEntry[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [proformaInvoices, setProformaInvoices] = useState<ProformaInvoice[]>([]);
  const [piBusy, setPiBusy] = useState(false);
  const [invoiceRefs, setInvoiceRefs] = useState<InvoiceReference[]>([]);
  const [tallyNumber, setTallyNumber] = useState("");
  const [invoiceRefBusy, setInvoiceRefBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editable order-header fields (buyer/vehicle note) — separate local state
  // so typing isn't clobbered by the periodic `load()` refresh, only reset
  // when a different order is loaded.
  const [headerDraft, setHeaderDraft] = useState({ buyerName: "", buyerContact: "", vehicleCapacityNote: "" });
  const [editingHeader, setEditingHeader] = useState(false);
  const [addItemSkuId, setAddItemSkuId] = useState("");
  const [addingLine, setAddingLine] = useState(false);
  const [removingLineId, setRemovingLineId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const o = await api.get<Order>(`/orders/${id}`);
      setOrder(o);
      // Available-stock context is useful while Final Qty is still
      // editable (DRAFT, FINALIZED, and now LOADED — post-pick adjustments
      // are allowed up to invoicing) — not once the order is locked and
      // there's nothing left to decide.
      if (o.status === "DRAFT" || o.status === "FINALIZED" || o.status === "LOADED") {
        const check = await api.get<StockCheckResult[]>(`/orders/${id}/stock-check`);
        setStockCheck(check);
      }
      if (o.status !== "DRAFT") {
        const pl = await api.get<PickListItem[]>(`/picking/orders/${id}`);
        setPickList(pl);
      }
      if (hasPermission("pricing.managePI")) {
        api
          .get<ProformaInvoice[]>(`/proforma-invoices/order/${id}`)
          .then(setProformaInvoices)
          .catch(() => {});
      }
      // Whole endpoint is gated on pricing.manageInvoiceReference — skip
      // the call entirely for an account that doesn't hold it, rather than
      // surfacing its 403 as a top-level error banner for a perfectly
      // normal, permitted state (same fix already applied to the old
      // standalone Pricing screen this section replaces).
      if (canManageInvoiceReference) {
        api
          .get<InvoiceReference[]>(`/invoice-references/order/${id}`)
          .then(setInvoiceRefs)
          .catch(() => {});
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load order");
    }
    // Activity/History is visible to every role that can see the order at
    // all — the API itself decides what detail (price etc.) each role gets
    // back, so the UI just renders whatever it's given.
    api
      .get<OrderAuditEntry[]>(`/orders/${id}/audit`)
      .then(setAuditEntries)
      .catch(() => {});
  }, [id, hasPermission, canManageInvoiceReference]);

  useEffect(() => {
    load();
    api.get<Sku[]>("/skus").then(setSkus).catch(() => {});
  }, [load]);

  useEffect(() => {
    if (order) {
      setHeaderDraft({
        buyerName: order.buyerName,
        buyerContact: order.buyerContact ?? "",
        vehicleCapacityNote: order.vehicleCapacityNote ?? "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  if (!order) return <p className="text-sm text-slate-500 dark:text-slate-400">{error ?? "Loading…"}</p>;

  const isDraft = order.status === "DRAFT";
  const isFinalized = order.status === "FINALIZED";
  const isLoaded = order.status === "LOADED";
  // Editable through LOADED — the server now allows editing a fully-picked,
  // not-yet-invoiced order too (post-pick adjustments: reducing Final Qty
  // below what's already been picked queues a Put-back task rather than
  // being rejected). Locked only at INVOICED/CANCELLED, matching the
  // server's own guard on PATCH /orders/:id.
  const isEditable = isDraft || isFinalized || isLoaded;

  // Left to throw — FinalQtyCell owns the Save button for this field and
  // shows its own per-field saving/success/error state (see #1: an onBlur
  // auto-save with no visible Save action and no confirmation of success
  // or failure isn't good enough).
  async function updateFinalQty(lineId: string, qtyFinalized: number, unit: string) {
    await api.patch(`/orders/${id}`, { lines: [{ id: lineId, qtyFinalized, unit }] });
    await load();
  }

  async function removeLine(lineId: string) {
    if (removingLineId) return;
    setError(null);
    setRemovingLineId(lineId);
    try {
      await api.patch(`/orders/${id}`, { lines: [{ id: lineId, remove: true }] });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove line");
    } finally {
      setRemovingLineId(null);
    }
  }

  async function addLine(skuId: string) {
    if (!skuId || addingLine) return;
    setError(null);
    setAddingLine(true);
    try {
      await api.patch(`/orders/${id}`, { lines: [{ skuId, qtyRequested: 1 }] });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add item");
    } finally {
      setAddingLine(false);
    }
  }

  async function saveHeader() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/orders/${id}`, {
        buyerName: headerDraft.buyerName,
        buyerContact: headerDraft.buyerContact,
        vehicleCapacityNote: headerDraft.vehicleCapacityNote,
      });
      setEditingHeader(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save order details");
    } finally {
      setBusy(false);
    }
  }

  async function handleFinalize() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/orders/${id}/finalize`);
      setNotice("Order finalized — pick list generated.");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const shortfalls = err.body?.shortfalls;
        setError(`${err.message}${shortfalls ? ": " + JSON.stringify(shortfalls) : ""}`);
      } else {
        setError(err instanceof ApiError ? err.message : "Finalize failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!confirm("Cancel this order?")) return;
    setBusy(true);
    try {
      await api.post(`/orders/${id}/cancel`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  // Writes a single line's Unit Price — the same PUT /orders/:id/pricing
  // endpoint the old standalone Pricing screen used, now called inline as
  // each line is edited instead of one batched "Save pricing" submit.
  // Server-side this is the write requireAllPermissions gates (see
  // canEditPrice above); a single-line array is a valid partial update.
  async function updateUnitPrice(lineId: string, unitPrice: number) {
    await api.put(`/orders/${id}/pricing`, { lines: [{ lineId, unitPrice }] });
    await load();
  }

  // Invoice Reference (Tally) — moved inline from the old standalone
  // Pricing screen, same spirit as the Proforma Invoice section below.
  // Uses whatever Unit Price is currently on each line (already-saved
  // value, or the SKU's Default Price as a fallback — same reasoning as
  // generatePi below) rather than a separate typed-but-unsaved price, since
  // there's now only one Unit Price control per line, not a second copy
  // living in this form's own local state.
  async function handleAddInvoiceReference(e: React.FormEvent) {
    e.preventDefault();
    if (!tallyNumber || !order) return;
    const unpriced = order.lines.filter((l) => l.unitPrice == null && l.defaultUnitPrice == null);
    if (unpriced.length > 0) {
      setError("Set a Unit Price for every line above, or a Default Price on the SKU, before creating the invoice reference.");
      return;
    }
    setInvoiceRefBusy(true);
    setError(null);
    try {
      await api.post("/invoice-references", {
        tallyInvoiceNumber: tallyNumber,
        orderId: id,
        lines: order.lines.map((l) => {
          const { unit, unitQty } = lineBilling(l);
          return { skuId: l.skuId, qty: unitQty, unit, price: l.unitPrice ?? l.defaultUnitPrice };
        }),
      });
      setTallyNumber("");
      setNotice("Invoice reference added.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add invoice reference");
    } finally {
      setInvoiceRefBusy(false);
    }
  }

  async function handleCancelInvoiceRef(refId: string) {
    if (invoiceRefBusy) return;
    const reverseStock = confirm("Were goods actually returned? OK = reverse stock, Cancel = paperwork-only void.");
    setInvoiceRefBusy(true);
    setError(null);
    try {
      await api.post(`/invoice-references/${refId}/cancel`, { reverseStock });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to cancel invoice reference");
    } finally {
      setInvoiceRefBusy(false);
    }
  }

  async function handleAdjustInvoiceRef(refId: string, lineId: string, currentQty: number, currentPrice: number) {
    if (invoiceRefBusy) return;
    const qtyStr = prompt("New quantity", String(currentQty));
    if (qtyStr === null) return;
    const priceStr = prompt("New price", String(currentPrice));
    if (priceStr === null) return;
    setInvoiceRefBusy(true);
    setError(null);
    try {
      await api.post(`/invoice-references/${refId}/adjust`, {
        lines: [{ invoiceLineId: lineId, qty: Number(qtyStr), price: Number(priceStr) }],
      });
      setNotice("Invoice reference adjusted; stock movement recorded.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to adjust invoice reference");
    } finally {
      setInvoiceRefBusy(false);
    }
  }

  // A PI is a snapshot of the order's current pricing at the moment it's
  // generated. Prefers a price already explicitly saved on the line (the
  // inline Unit Price editor below), and falls back to the SKU's Default
  // Price (MRP) when none has been saved yet — the same prefill-without-
  // binding role Default Price plays everywhere else pricing is entered.
  // This fallback matters for an account holding only pricing.managePI
  // (not pricing.manageInvoiceReference): saving the order's canonical
  // price requires both permissions (see requireAllPermissions in
  // routes/pricing.ts — a managePI-only account was previously able to
  // write that shared price despite being correctly blocked from Invoice
  // Reference creation), so a managePI-only account can still generate a PI
  // as long as the SKUs involved have a Default Price configured. If an
  // ACTIVE PI already exists for this order, this is a reissue (server
  // marks the old one SUPERSEDED and bumps the version) — same action, the
  // button label is just informative about which case applies.
  async function generatePi(validDays: number) {
    if (!order) return;
    setPiBusy(true);
    setError(null);
    try {
      const effectivePrice = (l: OrderLine) => l.unitPrice ?? l.defaultUnitPrice ?? null;
      if (order.lines.length === 0 || order.lines.some((l) => effectivePrice(l) == null)) {
        setError("Set a Unit Price for every line above, or a Default Price on the SKU, before generating a Proforma Invoice.");
        return;
      }
      const validUntil = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000).toISOString();
      await api.post("/proforma-invoices", {
        orderId: id,
        validUntil,
        lines: order.lines.map((l) => {
          const { unit, unitQty } = lineBilling(l);
          return { skuId: l.skuId, qty: unitQty, unit, unitPrice: effectivePrice(l) };
        }),
      });
      setNotice("Proforma Invoice generated.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to generate Proforma Invoice");
    } finally {
      setPiBusy(false);
    }
  }

  async function openPiPdf(piId: string) {
    setError(null);
    try {
      const token = getToken();
      const res = await fetch(`/api/proforma-invoices/${piId}/pdf`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!res.ok) throw new Error("Failed to load PDF");
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
    } catch {
      setError("Failed to load Proforma Invoice PDF");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">{order.orderNumber}</h1>
          {!editingHeader && (
            <p className="text-sm text-slate-500 dark:text-slate-400">{order.buyerName}{order.buyerContact ? ` · ${order.buyerContact}` : ""}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">{order.status}</span>
          {isDraft && canEdit && !editingHeader && (
            <button onClick={() => setEditingHeader(true)} className="text-xs font-medium text-slate-500 underline dark:text-slate-400">
              Edit details
            </button>
          )}
        </div>
      </div>

      {isDraft && canEdit && editingHeader ? (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">Buyer name</span>
              <input
                value={headerDraft.buyerName}
                onChange={(e) => setHeaderDraft({ ...headerDraft, buyerName: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">Contact</span>
              <input
                value={headerDraft.buyerContact}
                onChange={(e) => setHeaderDraft({ ...headerDraft, buyerContact: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">Vehicle / load note</span>
            <input
              value={headerDraft.vehicleCapacityNote}
              onChange={(e) => setHeaderDraft({ ...headerDraft, vehicleCapacityNote: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
          <div className="flex gap-2">
            <button onClick={saveHeader} disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
              Save
            </button>
            <button
              onClick={() => {
                setEditingHeader(false);
                setHeaderDraft({ buyerName: order.buyerName, buyerContact: order.buyerContact ?? "", vehicleCapacityNote: order.vehicleCapacityNote ?? "" });
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        order.vehicleCapacityNote && (
          <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            Vehicle note: {order.vehicleCapacityNote}
          </p>
        )
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">{notice}</p>}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2">SKU</th>
              <th className="px-4 py-2">Requested</th>
              <th className="px-4 py-2">Final qty</th>
              {!isDraft && <th className="px-4 py-2">Picked</th>}
              {isEditable && <th className="px-4 py-2">Available</th>}
              {canSeePrice && !isDraft && <th className="px-4 py-2">Unit price</th>}
              {isEditable && canEdit && <th className="px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {order.lines.map((line) => {
              const check = stockCheck.find((c) => c.lineId === line.id);
              const finalQty = line.qtyFinalized ?? line.qtyRequested;
              return (
                <tr key={line.id}>
                  <td className="px-4 py-2">
                    {line.sku.code}
                    <div className="text-xs text-slate-400">{line.sku.name}</div>
                  </td>
                  {/* Requested is the original ask — locked the moment the
                      line exists, never editable again. */}
                  <td className="px-4 py-2 text-slate-500 dark:text-slate-400">
                    {formatUnitQty(line.qtyRequested, line.sku.unit, line.requestedUnit, line.requestedUnitQty)}
                  </td>
                  <td className="px-4 py-2">
                    {isEditable && canEdit ? (
                      <FinalQtyCell
                        finalQty={finalQty}
                        sku={line.sku}
                        unit={line.finalUnit ?? line.requestedUnit ?? line.sku.unit}
                        unitQty={line.finalUnitQty ?? line.requestedUnitQty ?? finalQty}
                        onSave={(qty, unit) => updateFinalQty(line.id, qty, unit)}
                      />
                    ) : (
                      formatUnitQty(finalQty, line.sku.unit, line.finalUnit, line.finalUnitQty)
                    )}
                  </td>
                  {!isDraft && (
                    <td className="px-4 py-2">
                      {line.qtyPicked}
                      {!!line.pendingPutBackQty && (
                        <span
                          className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                          title="Already picked, no longer needed at the new Final Qty — awaiting warehouse confirmation to return it to stock. Not yet counted as available."
                        >
                          {line.pendingPutBackQty} pending return
                        </span>
                      )}
                    </td>
                  )}
                  {isEditable && (
                    <td className={`px-4 py-2 ${check && !check.sufficient ? "text-red-600 dark:text-red-400" : ""}`}>
                      {check ? check.available : "…"}
                      {check && check.committedElsewhere > 0 && (
                        <span className="ml-1 text-xs text-slate-400">({check.committedElsewhere} committed elsewhere)</span>
                      )}
                    </td>
                  )}
                  {canSeePrice && !isDraft && (
                    <td className="px-4 py-2">
                      <PriceCell
                        unitPrice={line.unitPrice ?? null}
                        defaultUnitPrice={line.defaultUnitPrice ?? null}
                        editable={canEditPrice}
                        onSave={(price) => updateUnitPrice(line.id, price)}
                      />
                    </td>
                  )}
                  {isEditable && canEdit && (
                    <td className="px-4 py-2">
                      <button
                        onClick={() => removeLine(line.id)}
                        disabled={removingLineId === line.id}
                        className="text-slate-400 hover:text-red-600 disabled:opacity-50"
                      >
                        {removingLineId === line.id ? "…" : "✕"}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Deliberately outside the table's `overflow-hidden` wrapper above —
          the combobox's results dropdown is absolutely positioned and would
          get clipped by that ancestor's overflow instead of rendering on
          top of the page. */}
      {isEditable && canEdit && (
        <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
          <SkuCombobox
            skus={skus}
            value={addItemSkuId}
            disabled={addingLine}
            onChange={(skuId) => {
              setAddItemSkuId(skuId);
              if (skuId) {
                addLine(skuId);
                setAddItemSkuId("");
              }
            }}
            placeholder={addingLine ? "Adding…" : "+ Add item… search by code or name"}
          />
        </div>
      )}

      {isDraft && canFinalize && (
        <button onClick={handleFinalize} disabled={busy} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
          {busy ? "Finalizing…" : "Finalize order & generate pick list"}
        </button>
      )}

      {!isDraft && pickList.length > 0 && (
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900 dark:text-slate-50">Pick list</h2>
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {pickList.map((item) => (
              <li key={item.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>
                  #{item.sequence} · {item.location.code} · {item.sku.code} × {item.qtyToPick}
                  {compoundBreakdown(item.qtyToPick, item.sku) && (
                    <span className="ml-1 text-xs text-slate-400">({compoundBreakdown(item.qtyToPick, item.sku)})</span>
                  )}
                  {item.isShortfallFollowup && (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      shortfall follow-up
                    </span>
                  )}
                </span>
                <span className={item.status === "PICKED" ? "text-green-600 dark:text-green-400" : "text-slate-400"}>{item.status}</span>
              </li>
            ))}
          </ul>
          {hasPermission("inventory.scanPutaway") && (
            <Link to={`/picking/${id}`} className="mt-2 inline-block text-sm font-medium text-slate-600 underline dark:text-slate-300">
              Go to picking screen →
            </Link>
          )}
        </section>
      )}

      {canManageInvoiceReference && !isDraft && (
        <InvoiceReferenceSection
          invoiceRefs={invoiceRefs}
          busy={invoiceRefBusy}
          tallyNumber={tallyNumber}
          onTallyNumberChange={setTallyNumber}
          onAdd={handleAddInvoiceReference}
          onCancel={handleCancelInvoiceRef}
          onAdjust={handleAdjustInvoiceRef}
        />
      )}

      {hasPermission("pricing.managePI") && !isDraft && (
        <ProformaInvoiceSection
          proformaInvoices={proformaInvoices}
          busy={piBusy}
          onGenerate={generatePi}
          onViewPdf={openPiPdf}
        />
      )}

      <ActivityPanel entries={auditEntries} expanded={showAudit} onToggle={() => setShowAudit((v) => !v)} />

      {hasRole("OWNER") && order.status !== "LOADED" && order.status !== "INVOICED" && order.status !== "CANCELLED" && (
        <button onClick={handleCancel} disabled={busy} className="w-full rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 dark:border-red-800 dark:text-red-400">
          Cancel order
        </button>
      )}
    </div>
  );
}

// baseQty is always canonical (Pcs); unit/unitQty are how it was actually
// entered — null unit (or unit === baseUnit) means it was entered in the
// base unit already, so there's no separate equivalent worth showing.
function formatUnitQty(baseQty: number, baseUnit: string, unit: string | null | undefined, unitQty: number | null | undefined) {
  if (!unit || unit === baseUnit || unitQty == null) return `${baseQty} ${baseUnit}`;
  return `${unitQty} ${unit} (${baseQty} ${baseUnit})`;
}

// What a line actually bills as — Proforma Invoice and Invoice Reference
// creation both bill per 1 of whichever unit the line was finalized in
// (falling back to requested, then the SKU's base unit), not the base-unit
// qty, since Box/bulk pricing carries its own margin. Mirrors the same
// unit-selection logic routes/pricing.ts and routes/orders.ts's
// skuDefaultPriceForUnit use server-side, kept in sync by hand since this
// is purely a display/billing-payload concern, not something the server
// needs to compute for the client.
function lineBilling(line: OrderLine) {
  const finalQty = line.qtyFinalized ?? line.qtyRequested;
  const unit = line.finalUnit ?? line.requestedUnit ?? line.sku.unit;
  const unitQty = line.finalUnitQty ?? line.requestedUnitQty ?? finalQty;
  return { unit, unitQty };
}

// Explicit edit -> Save/Cancel for the one editable quantity field, instead
// of an onBlur auto-save with no visible action and no feedback on whether
// it actually worked (see round 3 bug #1). Mirrors the same inline-edit
// pattern already used for SKU and Location master rows. Extended for
// multi-unit: lets staff enter/save in either the SKU's base unit or its
// alternate unit (e.g. Box), converting to base units server-side.
function FinalQtyCell({
  finalQty,
  sku,
  unit,
  unitQty,
  onSave,
}: {
  finalQty: number;
  sku: Sku;
  unit: string;
  unitQty: number;
  onSave: (qty: number, unit: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(unitQty));
  const [selectedUnit, setSelectedUnit] = useState(unit);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const units = availableUnits(sku);

  useEffect(() => {
    setValue(String(unitQty));
    setSelectedUnit(unit);
  }, [finalQty, unit, unitQty]);

  async function handleSave() {
    const v = Number(value);
    if (!(v >= 0)) {
      setError("Enter a valid quantity");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(v, selectedUnit);
      setEditing(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <span>{formatUnitQty(finalQty, sku.unit, unit, unitQty)}</span>
        <button
          onClick={() => {
            setEditing(true);
            setSaved(false);
            setValue(String(unitQty));
            setSelectedUnit(unit);
          }}
          className="text-xs font-medium text-blue-600 underline dark:text-blue-400"
        >
          Edit
        </button>
        {saved && <span className="text-xs text-green-600 dark:text-green-400">Saved ✓</span>}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0}
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          className="w-20 rounded border border-slate-300 px-2 py-1 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800"
        />
        {units.length > 1 ? (
          <select
            value={selectedUnit}
            disabled={saving}
            onChange={(e) => setSelectedUnit(e.target.value)}
            className="rounded border border-slate-300 px-1 py-1 text-xs disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800"
          >
            {units.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-slate-400">{sku.unit}</span>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setEditing(false);
            setValue(String(unitQty));
            setSelectedUnit(unit);
            setError(null);
          }}
          className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-700"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// Consolidation: Unit Price used to live only on the standalone Pricing
// screen — now it's directly editable in the order line table. Same
// explicit Edit -> Save/Cancel pattern as FinalQtyCell above, for the same
// reason (no onBlur auto-save with no visible action or confirmation — see
// round 3 bug #1). `editable` reflects canEditPrice (both financial-
// document permissions); a viewer with only one, or neither, still sees
// the value read-only per the server's own field-level protection.
function PriceCell({
  unitPrice,
  defaultUnitPrice,
  editable,
  onSave,
}: {
  unitPrice: number | null;
  defaultUnitPrice: number | null;
  editable: boolean;
  onSave: (price: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(unitPrice ?? defaultUnitPrice ?? ""));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(String(unitPrice ?? defaultUnitPrice ?? ""));
  }, [unitPrice, defaultUnitPrice]);

  function display() {
    if (unitPrice != null) return <span>₹{unitPrice}</span>;
    if (defaultUnitPrice != null) {
      return (
        <span className="text-slate-400" title="Prefilled from this SKU's Default Price (MRP) — not yet saved">
          ₹{defaultUnitPrice} (default)
        </span>
      );
    }
    return <span>—</span>;
  }

  if (!editable) return display();

  async function handleSave() {
    const v = Number(value);
    if (!(v >= 0)) {
      setError("Enter a valid price");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(v);
      setEditing(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        {display()}
        <button
          onClick={() => {
            setEditing(true);
            setSaved(false);
            setValue(String(unitPrice ?? defaultUnitPrice ?? ""));
          }}
          className="text-xs font-medium text-blue-600 underline dark:text-blue-400"
        >
          Edit
        </button>
        {saved && <span className="text-xs text-green-600 dark:text-green-400">Saved ✓</span>}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0}
          step="0.01"
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          className="w-24 rounded border border-slate-300 px-2 py-1 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setEditing(false);
            setValue(String(unitPrice ?? defaultUnitPrice ?? ""));
            setError(null);
          }}
          className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-700"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// Invoice Reference (Tally) — moved inline from the old standalone Pricing
// screen (deprecated entirely, see the order-screen consolidation), same
// spirit as ProformaInvoiceSection below: its own section on this one
// screen rather than a separate destination to navigate to.
function InvoiceReferenceSection({
  invoiceRefs,
  busy,
  tallyNumber,
  onTallyNumberChange,
  onAdd,
  onCancel,
  onAdjust,
}: {
  invoiceRefs: InvoiceReference[];
  busy: boolean;
  tallyNumber: string;
  onTallyNumberChange: (v: string) => void;
  onAdd: (e: React.FormEvent) => void;
  onCancel: (refId: string) => void;
  onAdjust: (refId: string, lineId: string, currentQty: number, currentPrice: number) => void;
}) {
  return (
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">Invoice Reference (Tally)</h2>

      {invoiceRefs.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {invoiceRefs.map((ref) => (
            <li key={ref.id} className="py-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-900 dark:text-slate-50">{ref.tallyInvoiceNumber}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    ref.status === "CANCELLED"
                      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                      : ref.status === "ADJUSTED"
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                        : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                  }`}
                >
                  {ref.status}
                </span>
              </div>
              <ul className="mt-1 space-y-1 text-xs text-slate-500 dark:text-slate-400">
                {ref.lines.map((l) => (
                  <li key={l.id} className="flex items-center justify-between">
                    <span>
                      {l.sku?.code ?? l.skuId} · {l.qty} {l.unit ?? l.sku?.unit ?? ""} × ₹{l.price}
                    </span>
                    {ref.status !== "CANCELLED" && (
                      <button onClick={() => onAdjust(ref.id, l.id, l.qty, l.price)} disabled={busy} className="text-xs underline disabled:opacity-50">
                        {busy ? "Working…" : "Adjust"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {ref.status !== "CANCELLED" && (
                <button
                  onClick={() => onCancel(ref.id)}
                  disabled={busy}
                  className="mt-1 text-xs font-medium text-red-600 underline disabled:opacity-50 dark:text-red-400"
                >
                  {busy ? "Working…" : "Cancel invoice reference"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onAdd} className="flex gap-2 pt-1">
        <input
          value={tallyNumber}
          disabled={busy}
          onChange={(e) => onTallyNumberChange(e.target.value)}
          placeholder="Tally invoice number"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />
        <button type="submit" disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
    </section>
  );
}

// Round 4 #5: Proforma Invoice — Owner/Accountant only, listed newest
// version first (the API already sorts that way). "Generate" and "Reissue"
// are the same action server-side; the label just reflects which case
// applies so it's clear a reissue supersedes rather than duplicates.
function ProformaInvoiceSection({
  proformaInvoices,
  busy,
  onGenerate,
  onViewPdf,
}: {
  proformaInvoices: ProformaInvoice[];
  busy: boolean;
  onGenerate: (validDays: number) => void;
  onViewPdf: (id: string) => void;
}) {
  const [validDays, setValidDays] = useState(15);
  const hasActive = proformaInvoices.some((p) => p.status === "ACTIVE");

  return (
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">Proforma Invoice</h2>
      <p className="text-xs text-slate-400">
        A preliminary document for advance collection — separate from the Tax Invoice recorded via Invoice Reference. Sending
        or reissuing a PI never itself moves stock or counts as final billing.
      </p>

      {proformaInvoices.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {proformaInvoices.map((pi) => (
            <li key={pi.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                {pi.piNumber} <span className="text-xs text-slate-400">(v{pi.version})</span>
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                    pi.status === "ACTIVE"
                      ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                      : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                  }`}
                >
                  {pi.status}
                </span>
              </span>
              <button onClick={() => onViewPdf(pi.id)} className="text-xs font-medium text-slate-600 underline dark:text-slate-300">
                View PDF
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 pt-1">
        <label className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          Valid for (days)
          <input
            type="number"
            min={1}
            value={validDays}
            onChange={(e) => setValidDays(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800"
          />
        </label>
        <button
          onClick={() => onGenerate(validDays)}
          disabled={busy}
          className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? "Generating…" : hasActive ? "Reissue Proforma Invoice" : "Generate Proforma Invoice"}
        </button>
      </div>
    </section>
  );
}

// Round 4 #1: order-level audit visibility. The API already redacts what
// each role gets back (Sales sees a summary sentence only; Owner/Accountant
// also get the raw before/after) — this just renders whatever came back,
// no client-side filtering of its own.
function ActivityPanel({
  entries,
  expanded,
  onToggle,
}: {
  entries: OrderAuditEntry[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-900 dark:text-slate-50"
      >
        Activity / history {entries.length > 0 && <span className="text-xs font-normal text-slate-400">({entries.length})</span>}
        <span className="text-xs text-slate-400">{expanded ? "Hide ▲" : "Show ▼"}</span>
      </button>
      {expanded && (
        <ul className="divide-y divide-slate-100 px-4 pb-3 dark:divide-slate-800">
          {entries.length === 0 && <li className="py-2 text-sm text-slate-400">No activity recorded yet.</li>}
          {entries.map((e) => (
            <li key={e.id} className="py-2 text-sm">
              <div className="text-slate-700 dark:text-slate-200">{e.summary}</div>
              <div className="text-xs text-slate-400">
                {e.user.name} ({e.user.role}) · {new Date(e.createdAt).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
