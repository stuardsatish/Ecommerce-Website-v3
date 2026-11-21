import { readFileSync, writeFileSync } from 'fs'

const path = './src/pages/BillingPage/BillingPage.jsx'
let c = readFileSync(path, 'utf8')

// 1. Add Download to lucide imports
c = c.replace(
  'RotateCcw, Printer, Tag, ChevronDown, ChevronUp, Moon, Bell, Check,\n} from "lucide-react"',
  'RotateCcw, Printer, Tag, ChevronDown, ChevronUp, Moon, Bell, Check, Download,\n} from "lucide-react"'
)

// 2. Add lastOrder state
c = c.replace(
  '  /* ── flow ── */\n  const [loading, setLoading] = useState(false)\n  const [result, setResult] = useState(null)',
  '  /* ── flow ── */\n  const [loading, setLoading] = useState(false)\n  const [result, setResult] = useState(null)\n  const [lastOrder, setLastOrder] = useState(null)'
)

// 3. Remove auto-download, add setLastOrder
c = c.replace(
  '      setResult({ success: true, orderId: billId, order: orderCreated })\n      toast.success(`Bill #${billId} generated successfully!`)\n\n      // Auto trigger invoice download\n      printInvoice(orderCreated)\n\n      // Clear bill',
  '      setResult({ success: true, orderId: billId, order: orderCreated })\n      setLastOrder(orderCreated)\n      toast.success(`Bill #${billId} generated successfully!`)\n\n      // No auto-download — user clicks Download Invoice below\n\n      // Clear bill'
)

// 4. Add download banner in JSX after the opening div
c = c.replace(
  '      {/* ── Top Bar: Header & Status Indicators ── */}',
  `      {/* ── Last Order Download Banner ── */}
      {lastOrder && (
        <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800">
            <Check className="w-4 h-4 text-emerald-600" />
            <span>Bill <span style={{ fontFamily: MONO }}>{lastOrder?.id}</span> created successfully!</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => printInvoice(lastOrder)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold rounded-xl transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Download Invoice
            </button>
            <button type="button" onClick={() => setLastOrder(null)} className="text-emerald-600 hover:text-emerald-800 p-1 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Top Bar: Header & Status Indicators ── */}`
)

writeFileSync(path, c, 'utf8')
console.log('BillingPage.jsx patched successfully')
