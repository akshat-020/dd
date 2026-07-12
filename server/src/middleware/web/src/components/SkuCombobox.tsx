import { useEffect, useMemo, useRef, useState } from "react";
import type { Sku } from "../api/types";

interface Props {
  skus: Sku[];
  value: string;
  onChange: (skuId: string) => void;
  placeholder?: string;
  // Optional per-SKU quantity to show alongside each match (e.g. "12 in stock").
  quantities?: Map<string, number>;
  className?: string;
}

// Search-as-you-type SKU picker — replaces plain <select> dropdowns, which
// become unusable once there are more than a couple dozen SKUs. Filters by
// code or name substring, case-insensitive.
export function SkuCombobox({ skus, value, onChange, placeholder = "Search SKU by code or name…", quantities, className }: Props) {
  const selected = skus.find((s) => s.id === value) ?? null;
  const [query, setQuery] = useState(selected ? `${selected.code} — ${selected.name}` : "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const current = skus.find((s) => s.id === value) ?? null;
    setQuery(current ? `${current.code} — ${current.name}` : "");
  }, [value, skus]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Once a SKU is selected, its display text ("CODE — Name") shouldn't
    // re-filter the list down to nothing — only filter while the user is
    // actively typing something that isn't just the selected label.
    if (!q || (selected && q === `${selected.code} — ${selected.name}`.toLowerCase())) {
      return skus.slice(0, 50);
    }
    return skus.filter((s) => s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)).slice(0, 50);
  }, [query, skus, selected]);

  function select(sku: Sku) {
    onChange(sku.id);
    setQuery(`${sku.code} — ${sku.name}`);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
          if (value) onChange(""); // typing invalidates the previous selection until a new one is made
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (matches[highlight]) select(matches[highlight]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
      />
      {open && matches.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800">
          {matches.map((s, idx) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => select(s)}
                className={`flex w-full items-center justify-between px-3 py-3 text-left text-sm ${
                  idx === highlight ? "bg-slate-100 dark:bg-slate-700" : ""
                }`}
              >
                <span>
                  <span className="font-mono font-semibold">{s.code}</span>
                  <span className="text-slate-500 dark:text-slate-400"> — {s.name}</span>
                </span>
                {quantities && <span className="shrink-0 text-xs text-slate-400">{quantities.get(s.id) ?? 0} available</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && query && matches.length === 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow-lg dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
          No matching SKU
        </div>
      )}
    </div>
  );
}
