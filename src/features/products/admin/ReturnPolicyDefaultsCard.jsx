import React, { useEffect, useMemo, useState } from "react"
import { Loader2, RefreshCw, RotateCcw, Save } from "lucide-react"
import { toast } from "react-toastify"
import { supabase } from "../../../context/SupabaseConfig"
import { getReturnPolicyDefaults, saveReturnPolicyDefaults } from "../../../services/settingsService"
import PolicyFields from "./PolicyFields"
import { categoryListsFromSettings, policyError, policyFromSettings, policyToSettings } from "./productForm"

// Admin ▸ Optimization: the STORE-WIDE return / exchange defaults (settings.returnPolicyDefaults).
// What they do: pre-fill the policy of every NEW product (and bulk-import rows that leave the policy blank).
// "Apply to existing products" pushes the current defaults to all matching existing products too.
// The database validates the same rules (windows 1–365 while enabled, none while disabled).

const sameCategory = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase()

export default function ReturnPolicyDefaultsCard() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [policy, setPolicy] = useState(() => policyFromSettings(null))
  const [lists, setLists] = useState({ noReturnCategories: [], noExchangeCategories: [] })
  const [known, setKnown] = useState([])     // categories that exist in the catalogue

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [doc, rows] = await Promise.all([getReturnPolicyDefaults(), supabase.from("products").select("category")])
        if (!active) return
        setPolicy(policyFromSettings(doc))
        setLists(categoryListsFromSettings(doc))
        const names = (rows.data || []).map((r) => String(r.category || "").trim()).filter(Boolean)
        setKnown([...new Set(names)].sort((a, b) => a.localeCompare(b)))
      } catch (err) {
        console.error("Failed to load the return policy defaults:", err)
        toast.error("Failed to load the return & exchange defaults.")
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [])

  // every catalogue category, plus any listed category that no product uses (yet)
  const rows = useMemo(() => {
    const out = [...known]
    for (const c of [...lists.noReturnCategories, ...lists.noExchangeCategories]) if (!out.some((x) => sameCategory(x, c))) out.push(c)
    return out
  }, [known, lists])

  const toggle = (key, category) => setLists((cur) => {
    const has = cur[key].some((c) => sameCategory(c, category))
    return { ...cur, [key]: has ? cur[key].filter((c) => !sameCategory(c, category)) : [...cur[key], category] }
  })
  const listed = (key, category) => lists[key].some((c) => sameCategory(c, category))

  const handleSave = async (e) => {
    e.preventDefault()
    const problem = policyError(policy)
    if (problem) { toast.error(`Store defaults: ${problem}`); return }
    setSaving(true)
    try {
      await saveReturnPolicyDefaults(policyToSettings(policy, lists))
      toast.success("Return & exchange defaults saved")
    } catch (err) {
      console.error("Failed to save the return policy defaults:", err)
      toast.error(String(err?.message || "").startsWith("Invalid return policy defaults") ? err.message : "Failed to save the return & exchange defaults.")
    } finally {
      setSaving(false)
    }
  }

  // Push the current defaults to ALL existing products, respecting per-category on/off overrides.
  const handleApplyToExisting = async () => {
    const problem = policyError(policy)
    if (problem) { toast.error(`Fix validation errors first: ${problem}`); return }
    setApplying(true)
    try {
      // First save the settings so they're consistent
      await saveReturnPolicyDefaults(policyToSettings(policy, lists))

      // Fetch all products (id + category)
      const { data: products, error: fetchErr } = await supabase
        .from("products")
        .select("id, category")
      if (fetchErr) throw fetchErr

      if (!products || products.length === 0) {
        toast.info("No existing products found.")
        return
      }

      // For each product, compute the correct policy based on its category
      const updates = products.map((p) => {
        const cat = String(p.category || "").trim().toLowerCase()
        const noReturn = lists.noReturnCategories.some((c) => sameCategory(c, cat))
        const noExchange = lists.noExchangeCategories.some((c) => sameCategory(c, cat))
        return {
          id: p.id,
          return_enabled: noReturn ? false : !!policy.returnEnabled,
          return_window_days: noReturn ? null : (policy.returnEnabled ? Number(policy.returnDays) : null),
          exchange_enabled: noExchange ? false : !!policy.exchangeEnabled,
          exchange_window_days: noExchange ? null : (policy.exchangeEnabled ? Number(policy.exchangeDays) : null),
        }
      })

      // Batch update in chunks of 100
      const CHUNK = 100
      for (let i = 0; i < updates.length; i += CHUNK) {
        const chunk = updates.slice(i, i + CHUNK)
        const { error: updateErr } = await supabase
          .from("products")
          .upsert(chunk, { onConflict: "id" })
        if (updateErr) throw updateErr
      }

      toast.success(`Applied return & exchange policy to ${products.length} existing product${products.length !== 1 ? "s" : ""}.`)
    } catch (err) {
      console.error("Failed to apply policy to existing products:", err)
      toast.error("Failed to apply policy to existing products.")
    } finally {
      setApplying(false)
    }
  }

  const reset = () => { setPolicy(policyFromSettings(null)); setLists({ noReturnCategories: [], noExchangeCategories: [] }) }

  if (loading) {
    return (
      <div className="bg-white rounded-3xl border border-neutral-200/80 p-8 flex items-center gap-3 text-neutral-500 text-sm">
        <Loader2 className="animate-spin" size={18} /> Loading return &amp; exchange defaults…
      </div>
    )
  }

  return (
    <div className="bg-white rounded-3xl border border-neutral-200/80 shadow-[0_10px_30px_rgba(0,0,0,0.02)] overflow-hidden">
      <form onSubmit={handleSave} className="p-6 md:p-8 space-y-6">
        <div className="border-b border-neutral-100 pb-4">
          <h2 className="text-xl font-bold text-neutral-800 flex items-center gap-2">
            <RotateCcw className="text-amber-600" size={22} /> Return &amp; Exchange Defaults
          </h2>
          <p className="text-neutral-500 text-sm mt-1">
            Sets the default policy for NEW products and bulk imports. Use <strong>Apply to existing products</strong> to push
            these values to products already in the catalogue (their individual settings will be overwritten).
          </p>
        </div>

        <PolicyFields idPrefix="store-policy" value={policy} onChange={setPolicy} />

        <div>
          <h3 className="text-sm font-bold text-neutral-800 uppercase tracking-wider mb-1">Categories that start with the policy OFF</h3>
          <p className="text-[12px] text-neutral-500 mb-3">
            Tick the categories whose new products should NOT be returnable / exchangeable by default (for example perishables or
            customised items). Remember any legal duty to remedy damaged or wrong items.
          </p>
          {rows.length === 0 ? (
            <p className="text-sm text-neutral-400">No categories yet — they appear here once products exist.</p>
          ) : (
            <div className="rounded-xl border border-neutral-200 divide-y divide-neutral-100">
              <div className="grid grid-cols-[1fr_auto_auto] gap-6 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-neutral-500">
                <span>Category</span><span>No returns</span><span>No exchanges</span>
              </div>
              {rows.map((c) => (
                <div key={c} className="grid grid-cols-[1fr_auto_auto] gap-6 px-4 py-2 items-center text-sm">
                  <span className="text-neutral-800">{c}</span>
                  <input type="checkbox" aria-label={`${c}: no returns`} checked={listed("noReturnCategories", c)} onChange={() => toggle("noReturnCategories", c)} className="mx-auto" />
                  <input type="checkbox" aria-label={`${c}: no exchanges`} checked={listed("noExchangeCategories", c)} onChange={() => toggle("noExchangeCategories", c)} className="mx-auto" />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 pt-2">
          <button
            type="button" onClick={reset} disabled={saving || applying}
            className="px-5 h-12 rounded-xl font-bold text-sm border border-neutral-300 text-neutral-700 hover:bg-neutral-50 cursor-pointer"
          >
            Reset to 7 / 7
          </button>
          <button
            type="button" onClick={handleApplyToExisting} disabled={saving || applying}
            className={`px-5 h-12 rounded-xl font-bold text-sm flex items-center justify-center gap-2 border transition-all ${applying ? "bg-neutral-100 text-neutral-400 border-neutral-200 cursor-not-allowed" : "border-blue-600 text-blue-700 hover:bg-blue-50 cursor-pointer"}`}
          >
            {applying ? <><Loader2 size={16} className="animate-spin" /> Applying…</> : <><RefreshCw size={16} /> Apply to existing products</>}
          </button>
          <button
            type="submit" disabled={saving || applying}
            className={`px-6 h-12 rounded-xl font-bold text-white text-sm tracking-wide flex items-center justify-center gap-2 shadow-md transition-all ${saving ? "bg-neutral-300 text-neutral-500 cursor-not-allowed shadow-none" : "bg-amber-600 hover:bg-amber-700 active:scale-[0.99] cursor-pointer"}`}
          >
            {saving ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : <><Save size={16} /> Save defaults</>}
          </button>
        </div>
      </form>
    </div>
  )
}