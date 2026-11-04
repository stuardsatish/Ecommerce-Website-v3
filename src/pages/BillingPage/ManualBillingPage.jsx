import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { supabase } from "../../context/SupabaseConfig"
import { callFunction } from "../../utils/edgeFunctions"
import { toast } from "react-toastify"
import generateInvoice from "../../utils/generateInvoice"
import { mapProductRows } from "../../utils/supabaseProducts"
import { getCategoryDiscounts, saveCategoryDiscounts } from "../../services/settingsService"
import {
  billLineKey, lineLabel, unitPriceOfOption, searchBillOptions, findOptionByCode, addOptionToBill,
  changeLineQty, setLinePrice, removeLine, manualBillingPayloadItems,
} from "../../features/pos/billOptions"
import {
  Search, Trash2, X, User, Phone, Mail, Loader2, ShoppingBag, Banknote, CreditCard, Smartphone,
  MoreHorizontal, Check, Clock, Package, Users, UserPlus, Receipt, RotateCcw,
} from "lucide-react"

const FONT = "'Inter', 'Plus Jakarta Sans', sans-serif"
const MONO = "'Space Grotesk', 'JetBrains Mono', monospace"
const formatINR = (n) => `₹${Number(n || 0).toFixed(2)}`
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

const CATEGORIES = [
  { key: "friends", label: "Friends" },
  { key: "retailer", label: "Retailer" },
  { key: "wholesale", label: "Wholesale" },
]

/**
 * Manual Billing — friends / retailers / wholesale buyers at a manually-set price (vs. /admin/billing's catalog-priced walk-in
 * counter). Every line's price starts at the category's default discount (Admin-settable below, settingsService) and can be
 * edited by hand. Customers are either a REGISTERED profile (tagged with this category on save) or a saved billing_contacts
 * row - the storefront's profiles table is 1:1 with an auth account, so a contact who never signed up is saved there instead.
 */
const ManualBillingPage = () => {
  const [products, setProducts] = useState([])
  const [billItems, setBillItems] = useState([])
  const [searchQuery, setSearchQuery] = useState("")
  const [showResults, setShowResults] = useState(false)
  const [skuInput, setSkuInput] = useState("")
  const searchRef = useRef(null)

  const [category, setCategory] = useState("friends")
  const [categoryDiscounts, setCategoryDiscounts] = useState({ friends: 0, retailer: 0, wholesale: 0 })
  const [savingDiscount, setSavingDiscount] = useState(false)

  const [customerQuery, setCustomerQuery] = useState("")
  const [customerResults, setCustomerResults] = useState([])
  const [customerSearching, setCustomerSearching] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState(null) // { kind: 'profile'|'contact', id, name, phone, email, tag }
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", email: "" })
  const [saveContact, setSaveContact] = useState(true)

  const [paymentMethod, setPaymentMethod] = useState("Cash")
  const [paymentStatus, setPaymentStatus] = useState("paid")

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => {
    ;(async () => {
      try {
        const { data, error } = await supabase.from("products").select("*")
        if (error) throw error
        setProducts(mapProductRows(data))
      } catch (e) {
        console.error("Failed to load products:", e)
      }
    })()
    getCategoryDiscounts().then(setCategoryDiscounts).catch(() => {})
  }, [])

  // Quick-pick: saved contacts already in this category, shown until the admin types a search of their own.
  useEffect(() => {
    if (customerQuery.trim() || selectedCustomer) return
    let active = true
    supabase
      .from("billing_contacts")
      .select("id, name, phone, email, category")
      .eq("category", category)
      .order("name")
      .limit(20)
      .then(({ data, error }) => {
        if (!active || error) return
        setCustomerResults((data || []).map((c) => ({ kind: "contact", id: c.id, name: c.name, phone: c.phone || "", email: c.email || "", tag: c.category })))
      })
    return () => { active = false }
  }, [category, customerQuery, selectedCustomer])

  const subtotal = useMemo(() => billItems.reduce((s, it) => s + it.finalPrice * it.quantity, 0), [billItems])
  const subtotalR = round2(subtotal)
  const totalItems = billItems.reduce((s, it) => s + it.quantity, 0)
  const searchResults = useMemo(() => searchBillOptions(products, searchQuery), [searchQuery, products])
  const categoryLabel = CATEGORIES.find((c) => c.key === category)?.label || category

  const addOption = useCallback((product, option) => {
    if (!option) { toast.warn(`"${product.title}" cannot be sold on its own — choose one of its variants`); return }
    const key = billLineKey(product.id, option.variantId)
    setBillItems((prev) => {
      const existed = prev.some((l) => l.lineKey === key)
      const r = addOptionToBill(prev, product, option)
      if (r.error) { toast.warn(r.error); return prev }
      const disc = categoryDiscounts[category] || 0
      if (existed || disc <= 0) return r.lines
      const { finalPrice } = unitPriceOfOption(product, option)
      return setLinePrice(r.lines, key, round2(finalPrice * (1 - disc / 100)))
    })
  }, [category, categoryDiscounts])

  const changeQty = (lineKey, delta) => {
    setBillItems((prev) => {
      const r = changeLineQty(prev, lineKey, delta)
      if (r.error) toast.warn(r.error)
      return r.lines
    })
  }
  const editPrice = (lineKey, value) => setBillItems((prev) => setLinePrice(prev, lineKey, value))
  const removeItem = (lineKey) => setBillItems((prev) => removeLine(prev, lineKey))

  const handleSkuEnter = (e) => {
    if (e.key !== "Enter") return
    e.preventDefault()
    const code = skuInput.trim()
    if (!code) return
    const hit = findOptionByCode(products, code)
    if (!hit) { toast.error(`No product with SKU "${code}"`); return }
    addOption(hit.product, hit.option)
    if (hit.option) setSkuInput("")
  }

  const searchCustomers = async () => {
    const q = customerQuery.trim()
    if (!q) return
    setCustomerSearching(true)
    try {
      const like = `%${q}%`
      const [{ data: profs }, { data: contacts }] = await Promise.all([
        supabase.from("profiles").select("id, name, phone, email, channel").or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`).limit(8),
        supabase.from("billing_contacts").select("id, name, phone, email, category").or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`).limit(8),
      ])
      const fromContacts = (contacts || []).map((c) => ({ kind: "contact", id: c.id, name: c.name, phone: c.phone || "", email: c.email || "", tag: c.category }))
      const fromProfiles = (profs || []).map((p) => ({ kind: "profile", id: p.id, name: p.name || "Customer", phone: p.phone || "", email: p.email || "", tag: p.channel || "Retail" }))
      setCustomerResults([...fromContacts, ...fromProfiles])
    } catch (e) {
      console.error(e)
      toast.error("Customer search failed")
    } finally {
      setCustomerSearching(false)
    }
  }

  const saveDefaultDiscount = async (value) => {
    const next = { ...categoryDiscounts, [category]: Math.min(100, Math.max(0, Number(value) || 0)) }
    setCategoryDiscounts(next)
    setSavingDiscount(true)
    try {
      await saveCategoryDiscounts(next)
      toast.success(`Default ${categoryLabel} discount saved`)
    } catch (e) {
      toast.error(e.message || "Could not save the default discount")
    } finally {
      setSavingDiscount(false)
    }
  }

  const selectCustomer = (c) => { setSelectedCustomer(c); setCustomerQuery(""); setCustomerResults([]) }
  const clearCustomer = () => { setSelectedCustomer(null); setNewCustomer({ name: "", phone: "", email: "" }) }

  const resetBill = useCallback(() => {
    setBillItems([])
    clearCustomer()
    setCustomerQuery("")
    setPaymentMethod("Cash")
    setPaymentStatus("paid")
    setSearchQuery("")
    setSkuInput("")
    setResult(null)
  }, [])

  const printInvoice = useCallback((order) => {
    try {
      generateInvoice({
        id: order?.id || order?.orderId || `ORD-${Date.now().toString().slice(-6)}`,
        orderId: order?.orderId || order?.id,
        userName: order?.userName || selectedCustomer?.name || newCustomer.name || "Customer",
        userPhone: order?.userPhone || selectedCustomer?.phone || newCustomer.phone || "—",
        userEmail: order?.userEmail || selectedCustomer?.email || newCustomer.email || "—",
        total: order?.total ?? subtotalR,
        paymentMethod: order?.paymentMethod || paymentMethod,
        paymentStatus: order?.paymentStatus || paymentStatus,
        createdAt: order?.createdAt || new Date(),
        products: order?.products || billItems.map((it) => ({ title: lineLabel(it), sku: it.sku || "—", price: it.finalPrice, quantity: it.quantity })),
        address: `Manual Billing · ${categoryLabel}`,
      })
    } catch (e) {
      console.error("Invoice PDF generation failed:", e)
      toast.error("Could not generate invoice PDF")
    }
  }, [selectedCustomer, newCustomer, subtotalR, paymentMethod, paymentStatus, billItems, categoryLabel])

  const generateManualBill = useCallback(async () => {
    if (!billItems.length) { toast.info("Add items to the bill first"); return }
    const name = selectedCustomer?.name || newCustomer.name.trim()
    if (!name) { toast.info("Enter the customer's name (or pick a saved contact)"); return }
    setLoading(true)
    setResult(null)
    try {
      const { res, data } = await callFunction("orders-manual-billing-create", {
        items: manualBillingPayloadItems(billItems),
        customerId: selectedCustomer?.kind === "profile" ? selectedCustomer.id : null,
        contactId: selectedCustomer?.kind === "contact" ? selectedCustomer.id : null,
        customerName: name,
        customerPhone: (selectedCustomer?.phone || newCustomer.phone || "").trim(),
        customerEmail: (selectedCustomer?.email || newCustomer.email || "").trim(),
        customerCategory: category,
        saveContact: !selectedCustomer && saveContact,
        paymentMethod,
        paymentStatus,
      })
      if (!res.ok || !data?.success) throw new Error(data?.error || "Could not create the order")
      setResult({ success: true, orderId: data.orderId, order: data.order })
      toast.success(`Order ${data.orderId} created`)
      printInvoice(data.order)
      resetBill()
    } catch (err) {
      toast.error(err.message || "Failed to create the order")
    } finally {
      setLoading(false)
    }
  }, [billItems, selectedCustomer, newCustomer, category, saveContact, paymentMethod, paymentStatus, printInvoice, resetBill])

  return (
    <div style={{ fontFamily: FONT }} className="flex-1 w-full space-y-5 min-w-0 text-[#2D3748] pb-16 pr-4 sm:pr-6 md:pr-8 lg:pr-10 max-w-[1440px]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-[#DCE8E0] flex items-center justify-center text-[#0F4C4C] shadow-xs shrink-0">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900 tracking-tight">Manual Billing</h2>
            <p className="text-xs text-gray-500 font-medium">Bill friends, retailers and wholesale buyers at a price you set — and save the contact for next time.</p>
          </div>
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 bg-white border border-[#E5DFD5] rounded-2xl p-1.5 w-fit">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategory(c.key)}
              className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer ${category === c.key ? "bg-[#104945] text-white" : "text-gray-500 hover:bg-gray-50"}`}
            >
              {c.label}{categoryDiscounts[c.key] > 0 ? ` · ${categoryDiscounts[c.key]}% off` : ""}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 bg-white border border-[#E5DFD5] rounded-2xl px-3 py-1.5 text-xs">
          <span className="text-gray-500 font-medium">Default {categoryLabel.toLowerCase()} discount</span>
          <input
            type="number"
            min="0"
            max="100"
            value={categoryDiscounts[category]}
            onChange={(e) => setCategoryDiscounts((p) => ({ ...p, [category]: e.target.value }))}
            onBlur={(e) => saveDefaultDiscount(e.target.value)}
            disabled={savingDiscount}
            className="w-14 px-1.5 py-1 text-right bg-[#F6F2EC] border border-[#E8E2D9] rounded-lg font-bold text-gray-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0F4C4C]/20 focus:border-[#0F4C4C]"
          />
          <span className="text-gray-500 font-medium">% off catalog price, applied to new lines</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* LEFT */}
        <div className="lg:col-span-8 space-y-4">
          {/* Product search */}
          <div className="bg-white rounded-3xl p-4 shadow-[0_2px_10px_rgba(0,0,0,0.02)] border border-[#E5DFD5] space-y-2.5">
            <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-gray-600 uppercase">
              <Search className="w-3.5 h-3.5 text-gray-400" />
              <span>Search Products</span>
            </div>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none"><Search className="w-4 h-4 text-gray-400" /></div>
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setShowResults(true) }}
                onFocus={() => setShowResults(true)}
                className="w-full pl-10 pr-4 py-2.5 bg-[#F6F2EC] border border-[#E8E2D9] rounded-xl text-xs placeholder-gray-400 text-gray-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0F4C4C]/20 focus:border-[#0F4C4C] transition-all"
                placeholder="Search by name, SKU, or category…"
                type="text"
              />
              {searchQuery && (
                <button onClick={() => { setSearchQuery(""); setShowResults(false) }} className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600" type="button"><X className="w-4 h-4" /></button>
              )}
              {showResults && searchResults.length > 0 && (
                <div className="absolute top-12 left-0 right-0 z-30 bg-white border border-[#E5DFD5] rounded-2xl shadow-xl max-h-72 overflow-y-auto p-2 space-y-1">
                  {searchResults.map(({ key, product: p, option }) => {
                    const { discount, finalPrice } = unitPriceOfOption(p, option)
                    const optionLabel = option.kind === "variant" ? ` — ${option.name}` : option.kind === "main" ? " (main product)" : ""
                    return (
                      <button
                        key={key}
                        onClick={() => { addOption(p, option); setSearchQuery(""); setShowResults(false); searchRef.current?.focus() }}
                        className="w-full flex items-center justify-between p-2 rounded-xl text-left transition-colors cursor-pointer hover:bg-[#FAF8F5]"
                        type="button"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-lg bg-stone-100 flex items-center justify-center overflow-hidden shrink-0">
                            {option.image || p.thumbnail ? <img src={option.image || p.thumbnail} alt="" className="w-full h-full object-cover" /> : <Package className="w-4 h-4 text-stone-400" />}
                          </div>
                          <div className="min-w-0">
                            <h5 className="text-xs font-semibold text-gray-900 truncate">{p.title}{optionLabel}</h5>
                            <p style={{ fontFamily: MONO }} className="text-[10px] text-gray-400">{option.sku || "—"} · {p.category || "General"}</p>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <span style={{ fontFamily: MONO }} className="text-xs font-bold text-[#0F4C4C]">{formatINR(finalPrice)}</span>
                          {discount > 0 && <span className="block text-[10px] text-emerald-600 font-semibold">{discount}% off</span>}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none"><Package className="w-4 h-4 text-gray-400" /></div>
              <input
                value={skuInput}
                onChange={(e) => setSkuInput(e.target.value)}
                onKeyDown={handleSkuEnter}
                style={{ fontFamily: MONO }}
                className="w-full pl-10 pr-4 py-2.5 bg-[#F6F2EC] border border-[#E8E2D9] rounded-xl text-xs placeholder-gray-400 text-gray-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0F4C4C]/20 focus:border-[#0F4C4C] transition-all"
                placeholder="Enter SKU, then press Enter"
                type="text"
              />
            </div>
          </div>

          {/* Bill table */}
          <div className="bg-white rounded-3xl p-5 shadow-[0_2px_10px_rgba(0,0,0,0.02)] border border-[#E5DFD5]">
            <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-gray-700 uppercase mb-4">
              <ShoppingBag className="w-4 h-4 text-gray-500" />
              <span>Current Bill ({totalItems} {totalItems === 1 ? "Item" : "Items"})</span>
            </div>
            {billItems.length === 0 ? (
              <div className="text-center py-12 text-gray-400 text-xs">
                <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
                No items in bill yet. Search for a product above.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="text-[10px] font-bold text-gray-400 tracking-wider uppercase border-b border-[#F0EBE3]">
                      <th className="py-2.5 pl-1 w-6">#</th>
                      <th className="py-2.5">Product</th>
                      <th className="py-2.5 text-right">MRP</th>
                      <th className="py-2.5 text-right w-28">Your price</th>
                      <th className="py-2.5 text-center w-28">Qty</th>
                      <th className="py-2.5 text-right">Total</th>
                      <th className="py-2.5 pr-1 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 font-medium">
                    {billItems.map((item, idx) => (
                      <tr key={item.lineKey} className="group hover:bg-[#FAF8F5]/60 transition-colors">
                        <td style={{ fontFamily: MONO }} className="py-3 pl-1 text-gray-400">{idx + 1}</td>
                        <td className="py-3">
                          <div className="font-semibold text-gray-900 leading-none">{lineLabel(item)}</div>
                          <div className="text-[10px] text-gray-400 mt-1">{item.sku || "-"}</div>
                        </td>
                        <td style={{ fontFamily: MONO }} className="py-3 text-right line-through text-gray-400">{formatINR(item.mrp)}</td>
                        <td className="py-3 text-right">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={item.finalPrice}
                            onChange={(e) => editPrice(item.lineKey, e.target.value)}
                            style={{ fontFamily: MONO }}
                            className="w-24 text-right px-2 py-1 bg-[#F6F2EC] border border-[#E8E2D9] rounded-lg text-xs font-bold text-gray-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0F4C4C]/20 focus:border-[#0F4C4C]"
                          />
                        </td>
                        <td className="py-3 text-center">
                          <div className="inline-flex items-center justify-center gap-1.5">
                            <button onClick={() => changeQty(item.lineKey, -1)} aria-label="Decrease quantity" className="w-5 h-5 rounded-md bg-[#F4EFEA] text-gray-600 flex items-center justify-center hover:bg-gray-200 text-xs cursor-pointer" type="button">-</button>
                            <span style={{ fontFamily: MONO }} className="w-5 font-semibold text-gray-900 text-center">{item.quantity}</span>
                            <button onClick={() => changeQty(item.lineKey, 1)} aria-label="Increase quantity" className="w-5 h-5 rounded-md bg-[#F4EFEA] text-gray-600 flex items-center justify-center hover:bg-gray-200 text-xs cursor-pointer" type="button">+</button>
                          </div>
                        </td>
                        <td style={{ fontFamily: MONO }} className="py-3 text-right font-bold text-gray-900">{formatINR(item.finalPrice * item.quantity)}</td>
                        <td className="py-3 pr-1 text-right">
                          <button onClick={() => removeItem(item.lineKey)} aria-label="Remove item" className="text-gray-300 hover:text-rose-500 transition-colors cursor-pointer" type="button"><Trash2 className="w-3.5 h-3.5 inline" /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="pt-4 mt-2 border-t border-[#F0EBE3] flex justify-end items-center gap-3">
              <span className="text-xs font-medium text-gray-500">Subtotal</span>
              <span style={{ fontFamily: MONO }} className="text-sm font-bold text-gray-900">{formatINR(subtotalR)}</span>
            </div>
          </div>

          {/* Customer card */}
          <div className="bg-white rounded-3xl p-4 shadow-[0_2px_10px_rgba(0,0,0,0.02)] border border-[#E5DFD5] space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-gray-700 uppercase">
              <User className="w-4 h-4 text-gray-500" />
              <span>{categoryLabel} customer</span>
            </div>

            {selectedCustomer ? (
              <div className="flex items-center justify-between p-3 bg-[#FAF8F5] border border-[#EAE4DC] rounded-xl">
                <div>
                  <h5 className="text-xs font-bold text-gray-900">{selectedCustomer.name}</h5>
                  <p className="text-[11px] text-gray-500 mt-0.5">{selectedCustomer.phone || "—"}{selectedCustomer.email ? ` · ${selectedCustomer.email}` : ""} · {selectedCustomer.kind === "profile" ? "registered" : "saved contact"} · {selectedCustomer.tag}</p>
                </div>
                <button onClick={clearCustomer} className="px-2.5 py-1 text-xs font-semibold text-gray-600 hover:text-gray-900 cursor-pointer" type="button">Change</button>
              </div>
            ) : (
              <>
                <div className="relative flex items-center">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none"><Search className="w-4 h-4 text-gray-400" /></div>
                  <input
                    value={customerQuery}
                    onChange={(e) => setCustomerQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchCustomers() } }}
                    className="w-full pl-10 pr-20 py-2 bg-[#F6F2EC] border border-[#E8E2D9] rounded-xl text-xs placeholder-gray-400 text-gray-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0F4C4C]/20 focus:border-[#0F4C4C] transition-all"
                    placeholder="Search saved contacts or registered customers by name, phone or email"
                    type="text"
                  />
                  <button onClick={searchCustomers} disabled={customerSearching} className="absolute right-2 px-2.5 py-1 bg-white border border-[#E0D9CE] rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 flex items-center gap-1 shadow-2xs cursor-pointer disabled:opacity-50" type="button">
                    {customerSearching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3 text-gray-500" />}
                    <span>Find</span>
                  </button>
                </div>

                {customerResults.length > 0 && (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {!customerQuery.trim() && <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Saved {categoryLabel.toLowerCase()} contacts</p>}
                    {customerResults.map((c) => (
                      <button
                        key={`${c.kind}-${c.id}`}
                        onClick={() => selectCustomer(c)}
                        className="w-full flex items-center justify-between p-2.5 bg-[#FAF8F5] border border-[#EAE4DC] rounded-xl hover:border-gray-300 transition-colors text-left cursor-pointer"
                        type="button"
                      >
                        <div>
                          <h5 className="text-xs font-semibold text-gray-900">{c.name}</h5>
                          <p className="text-[11px] text-gray-500 mt-0.5">{c.phone || c.email || "—"}</p>
                        </div>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#E5F1EE] text-[#0C6A5E]">{c.tag}</span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="pt-2 border-t border-[#F0EBE3] space-y-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                    <UserPlus className="w-3.5 h-3.5" /> Or a new contact
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><User className="w-3.5 h-3.5 text-gray-400" /></div>
                      <input value={newCustomer.name} onChange={(e) => setNewCustomer((p) => ({ ...p, name: e.target.value }))} placeholder="Name" className="w-full pl-8 pr-3 py-2 bg-[#F6F2EC] border border-[#E8E2D9] rounded-xl text-xs text-gray-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0F4C4C]/20 focus:border-[#0F4C4C]" />
                    </div>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><Phone className="w-3.5 h-3.5 text-gray-400" /></div>
                      <input value={newCustomer.phone} onChange={(e) => setNewCustomer((p) => ({ ...p, phone: e.target.value }))} placeholder="Phone" className="w-full pl-8 pr-3 py-2 bg-[#F6F2EC] border border-[#E8E2D9] rounded-xl text-xs text-gray-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0F4C4C]/20 focus:border-[#0F4C4C]" />
                    </div>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><Mail className="w-3.5 h-3.5 text-gray-400" /></div>
                      <input value={newCustomer.email} onChange={(e) => setNewCustomer((p) => ({ ...p, email: e.target.value }))} placeholder="Email" className="w-full pl-8 pr-3 py-2 bg-[#F6F2EC] border border-[#E8E2D9] rounded-xl text-xs text-gray-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0F4C4C]/20 focus:border-[#0F4C4C]" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] font-medium text-gray-600 cursor-pointer">
                    <input type="checkbox" checked={saveContact} onChange={(e) => setSaveContact(e.target.checked)} />
                    Save as a {categoryLabel.toLowerCase()} contact for next time
                  </label>
                </div>
              </>
            )}
          </div>
        </div>

        {/* RIGHT */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-white rounded-3xl p-5 shadow-[0_2px_10px_rgba(0,0,0,0.02)] border border-[#E5DFD5] space-y-3.5">
            <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-gray-700 uppercase"><Receipt className="w-4 h-4 text-gray-500" /><span>Total</span></div>
            <div className="pt-1 flex justify-between items-baseline">
              <span className="text-xs font-bold text-gray-900">Grand Total</span>
              <span style={{ fontFamily: MONO }} className="text-2xl font-bold text-[#0F4C4C]">{formatINR(subtotalR)}</span>
            </div>
          </div>

          <div className="bg-white rounded-3xl p-5 shadow-[0_2px_10px_rgba(0,0,0,0.02)] border border-[#E5DFD5] space-y-4">
            <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-gray-700 uppercase"><CreditCard className="w-4 h-4 text-gray-500" /><span>Payment Method</span></div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { key: "Cash", label: "Cash", Icon: Banknote },
                { key: "UPI", label: "UPI", Icon: Smartphone },
                { key: "Bank Transfer", label: "Bank Transfer", Icon: CreditCard },
                { key: "Other", label: "Other", Icon: MoreHorizontal },
              ].map(({ key, label: pLbl, Icon }) => {
                const isSelected = paymentMethod === key
                return (
                  <button key={key} onClick={() => setPaymentMethod(key)} className={`py-2.5 px-3 rounded-xl flex items-center justify-center gap-2 text-xs font-semibold transition-all cursor-pointer ${isSelected ? "border-2 border-emerald-500 bg-white text-gray-900 shadow-2xs" : "border border-[#E8E2D9] bg-white hover:bg-gray-50 text-gray-700"}`} type="button">
                    <Icon className={`w-4 h-4 ${isSelected ? "text-emerald-600" : "text-gray-400"}`} />
                    <span>{pLbl}</span>
                  </button>
                )
              })}
            </div>
            <div className="space-y-1.5 pt-1">
              <div className="text-[10px] font-bold text-gray-400 tracking-wider uppercase">Payment Status</div>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setPaymentStatus("paid")} className={`py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 text-xs font-semibold transition-all cursor-pointer ${paymentStatus === "paid" ? "bg-emerald-50 border border-emerald-500 text-emerald-700 shadow-2xs" : "bg-white border border-[#E8E2D9] text-gray-600 hover:bg-gray-50"}`} type="button">
                  <Check className="w-3.5 h-3.5 text-emerald-600" /><span>Paid</span>
                </button>
                <button onClick={() => setPaymentStatus("pending")} className={`py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium transition-all cursor-pointer ${paymentStatus === "pending" ? "bg-amber-50 border border-amber-500 text-amber-700 shadow-2xs font-semibold" : "bg-white border border-[#E8E2D9] text-gray-600 hover:bg-gray-50"}`} type="button">
                  <Clock className="w-3.5 h-3.5 text-amber-600" /><span>Pending</span>
                </button>
              </div>
            </div>

            <button
              onClick={generateManualBill}
              disabled={loading || !billItems.length}
              className="w-full py-3.5 px-4 bg-[#104945] hover:bg-[#0D3B38] text-white rounded-2xl font-bold text-sm tracking-wide flex items-center justify-center gap-2 shadow-md hover:shadow-lg transition-all active:scale-[0.99] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              type="button"
            >
              {loading ? (<><Loader2 className="w-4 h-4 animate-spin" /><span>Processing…</span></>) : (<><Receipt className="w-4 h-4 text-emerald-200" /><span>Create Order · {formatINR(subtotalR)}</span></>)}
            </button>
            <button onClick={resetBill} disabled={!billItems.length && !result} className="w-full py-2.5 px-3 rounded-xl border border-[#F2D7D7] bg-white hover:bg-rose-50 text-rose-600 flex items-center justify-center gap-1.5 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50" type="button">
              <RotateCcw className="w-3.5 h-3.5 text-rose-500" /><span>Clear All</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ManualBillingPage