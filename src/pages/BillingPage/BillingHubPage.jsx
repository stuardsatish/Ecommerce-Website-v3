import { useSearchParams } from "react-router-dom"
import BillingPage from "./BillingPage"
import ManualBillingPage from "./ManualBillingPage"

const TABS = [
  { key: "offline", label: "Offline Billing" },
  { key: "manual", label: "Manual Billing" },
]

/**
 * Billing hub — /admin/billing?view=offline (the walk-in counter, catalog-priced) and ?view=manual (friends / retailers /
 * wholesale at a manually-set price). Same tab pattern as /admin/add-product (ProductsHubPage) and /admin/customers
 * (CustomersHubPage): both tabs stay mounted, only their visibility toggles, so neither loses its in-progress bill on switch.
 */
const BillingHubPage = () => {
  const [params, setParams] = useSearchParams()
  const activeTab = params.get("view") === "manual" ? "manual" : "offline"

  const switchTab = (key) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set("view", key)
      return next
    }, { replace: true })
  }

  return (
    <div className="flex-1 w-full min-h-screen px-4 sm:px-6 md:px-8 py-5 max-w-[1440px] mx-auto">
      <div className="flex items-center gap-2 bg-white border border-[#E5DFD5] rounded-2xl p-1.5 w-fit mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer ${activeTab === t.key ? "bg-[#104945] text-white" : "text-gray-500 hover:bg-gray-50"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: activeTab === "offline" ? "block" : "none" }}>
        <BillingPage />
      </div>
      <div style={{ display: activeTab === "manual" ? "block" : "none" }}>
        <ManualBillingPage />
      </div>
    </div>
  )
}

export default BillingHubPage