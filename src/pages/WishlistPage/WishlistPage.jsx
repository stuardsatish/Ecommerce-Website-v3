import React, { useState, useEffect } from "react"
import { useSelector, useDispatch } from "react-redux"
import { useNavigate } from "react-router-dom"
import { removeWishlist } from "../../context/WishlistSlice"
import { addCart } from "../../context/CartSlice"
import { Trash2, ShoppingBag, ArrowRight, ArrowLeft, ChevronRight, Share2, ShoppingCart, X, Bell } from "lucide-react"
import { supabase } from "../../context/SupabaseConfig"
import { mapProductRows } from "../../utils/supabaseProducts"
import { upsertCartItem, nextAddQuantity } from "../../utils/supabaseCart"
import { removeWishlistItem } from "../../utils/supabaseWishlist"
import { formatCurrency } from "../../utils/pricing"
import { toast } from "react-toastify"
import useIsMobile from "../../hooks/useIsMobile"
import Skeleton from "../../components/Common/Skeleton"

const WishlistPage = () => {
  const navigate = useNavigate()
  const dispatch = useDispatch()
  const wishlistItems = useSelector((state) => state.wishlist.wishlistItems)
  const cartItems = useSelector((state) => state.cart.cartItems)
  const user = useSelector((state) => state.user.user)
  // Mobile design renders below `lg`; the desktop redesign at lg+.
  const isMobile = useIsMobile(1024)

  /* ---------- DESKTOP: enrichment + recommendations ---------- */
  // Shared formatter; the currency symbol lives in utils/pricing.js so it
  // cannot drift between screens again.
  const money = formatCurrency
  const LOW_STOCK = 5
  const pidOf = (item) => item.productId || item.id

  const [productMap, setProductMap] = useState({})
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [recommended, setRecommended] = useState([])
  const [loadingRec, setLoadingRec] = useState(true)
  const [alertedIds, setAlertedIds] = useState([])

  const wishlistKey = wishlistItems.map(pidOf).join(",")

  // Join each wishlist item with its live product row (stock / mrp for badges).
  useEffect(() => {
    let active = true
    ;(async () => {
      setLoadingProducts(true)
      try {
        const ids = [...new Set(wishlistItems.map(pidOf).filter(Boolean))].map(String)
        if (!ids.length) {
          if (active) setProductMap({})
          return
        }
        const { data, error } = await supabase.from("products").select("*").in("id", ids)
        if (error) throw error
        const map = {}
        mapProductRows(data).forEach((p) => { map[p.id] = p })
        if (active) setProductMap(map)
      } catch (e) {
        console.log("wishlist product join failed:", e)
        if (active) setProductMap({})
      } finally {
        if (active) setLoadingProducts(false)
      }
    })()
    return () => { active = false }
  }, [wishlistKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Recommended: top-rated products not already in the wishlist.
  useEffect(() => {
    let active = true
    ;(async () => {
      setLoadingRec(true)
      try {
        let { data, error } = await supabase
          .from("products")
          .select("*")
          .order("rating", { ascending: false })
          .limit(12)
        if (error) {
          ({ data, error } = await supabase.from("products").select("*").limit(12))
          if (error) throw error
        }
        const wishIds = new Set(wishlistItems.map(pidOf).map(String))
        const list = mapProductRows(data).filter((p) => !wishIds.has(String(p.id))).slice(0, 4)
        if (active) setRecommended(list)
      } catch (e) {
        console.log("recommended fetch failed:", e)
      } finally {
        if (active) setLoadingRec(false)
      }
    })()
    return () => { active = false }
  }, [wishlistKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Derive a stock badge from the joined product's stock.
  const stockInfo = (pid) => {
    const stock = Number(productMap[pid]?.stock)
    if (Number.isFinite(stock)) {
      if (stock <= 0) return { status: "OUT", label: "OUT OF STOCK" }
      if (stock <= LOW_STOCK) return { status: "LOW", label: `ONLY ${stock} LEFT`, left: stock }
      return { status: "IN", label: "IN STOCK" }
    }
    return { status: "IN", label: "IN STOCK" } // unknown stock → treat as available
  }

  const mrpOf = (pid) => Number(productMap[pid]?.mrp ?? productMap[pid]?.originalPrice ?? 0)

  // Prefer the live product doc's image over the wishlist item's own snapshot —
  // the item was frozen at the moment it was saved, so if the product's photo
  // was changed since, the snapshot would keep showing the old one forever.
  const liveImageOf = (item) => {
   const pid = pidOf(item)
   const live = productMap[pid]
   return (live && (live.thumbnail || live.image)) || item.thumbnail || item.image
  }

  /* ---------- DESKTOP handlers (reuse existing Redux actions) ---------- */
  const handleRemove = async (pid) => {
    dispatch(removeWishlist(pid)) // instant UI
    if (!user?.uid) return
    try {
      await removeWishlistItem(user.uid, pid)
    } catch (e) {
      console.log("wishlist remove persist failed:", e)
    }
  }

  const handleAddToCart = (item) => {
    const pid = pidOf(item)
    const qty = nextAddQuantity(cartItems, pid)
    dispatch(addCart(item))
    upsertCartItem(user?.uid, item, qty)
    toast.success("Added to cart")
  }

  const handleMoveAll = () => {
    const inStock = wishlistItems.filter((i) => stockInfo(pidOf(i)).status !== "OUT")
    if (!inStock.length) { toast.info("No in-stock items to move."); return }
    inStock.forEach((i) => {
      const pid = pidOf(i)
      const qty = nextAddQuantity(cartItems, pid)
      dispatch(addCart(i))
      upsertCartItem(user?.uid, i, qty)
      handleRemove(pid)
    })
    toast.success(`Moved ${inStock.length} item(s) to cart`)
    navigate("/cart")
  }

  const handleShare = async () => {
    const url = window.location.href
    try {
      if (navigator.share) await navigator.share({ title: "My Wishlist", url })
      else { await navigator.clipboard.writeText(url); toast.success("Wishlist link copied to clipboard!") }
    } catch { /* user dismissed the share sheet */ }
  }

  const handleNotify = async (pid) => {
    const uid = user?.uid
    if (!uid) { navigate("/login"); return }
    try {
      const { error } = await supabase.from("stock_alerts").insert({ product_id: String(pid), user_id: uid })
      if (error) throw error
      setAlertedIds((prev) => [...prev, String(pid)])
      toast.success("We'll notify you when it's back in stock")
    } catch (e) {
      console.log("stock alert failed:", e)
      toast.error("Could not set the alert")
    }
  }

  /* ============================================================
     MOBILE LAYOUT (≤1024px) — shares all Redux state/handlers.
  ============================================================ */
  if (isMobile) {
    return (
      <div className="min-h-screen w-full" style={{ background: "var(--color-background)", fontFamily: "Inter, sans-serif", overflowX: "hidden", maxWidth: "100vw" }}>
        {wishlistItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center" style={{ minHeight: "100vh", gap: "16px", padding: "96px 24px 0" }}>
            <ShoppingBag size={44} color="var(--color-border-strong)" />
            <p style={{ color: "var(--color-muted)", fontSize: "14px", fontWeight: 600 }}>Your wishlist is empty.</p>
            <button onClick={() => navigate("/products")} style={{ background: "var(--color-primary)", color: "var(--color-inverse)", fontWeight: 700, fontSize: "14px", padding: "12px 24px", borderRadius: "9999px" }}>
              Explore Products
            </button>
          </div>
        ) : loadingProducts ? (
          <main className="grid grid-cols-2" style={{ gap: "16px", padding: "96px 20px 24px" }} aria-busy="true">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="relative bg-surface flex flex-col overflow-hidden"
                style={{ borderRadius: "12px", boxShadow: "0px 4px 20px rgba(26,43,60,0.05)" }}
                aria-hidden="true"
              >
                <div style={{ background: "var(--color-surface-muted)", padding: "8px" }}>
                  <div
                    className="w-full aspect-square animate-pulse"
                    style={{ background: "var(--color-border)", borderRadius: "8px" }}
                  />
                </div>
                <div className="flex flex-col flex-1" style={{ padding: "12px" }}>
                  <Skeleton className="h-3 w-1/2 mb-2" />
                  <Skeleton className="h-3.5 w-full mb-1" />
                  <Skeleton className="h-3.5 w-2/3" />
                  <div style={{ marginTop: "auto" }}>
                    <Skeleton className="h-5 w-20 mb-2" />
                    <Skeleton className="w-full h-9 rounded-full" />
                  </div>
                </div>
              </div>
            ))}
          </main>
        ) : (
          <main className="grid grid-cols-2" style={{ gap: "16px", padding: "96px 20px 24px" }}>
            {wishlistItems.map((item) => {
              const pid = item.productId || item.id
              return (
                <div key={pid} className="relative bg-surface flex flex-col overflow-hidden" style={{ borderRadius: "12px", boxShadow: "0px 4px 20px rgba(26,43,60,0.05)" }}>
                  <button
                    onClick={() => { if (window.confirm("Remove this item from your wishlist?")) handleRemove(pid) }}
                    aria-label="Remove from wishlist"
                    className="absolute z-20 flex items-center justify-center"
                    style={{ top: "12px", right: "12px", width: "32px", height: "32px", background: "color-mix(in srgb, var(--color-surface) 90%, transparent)", borderRadius: "9999px", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
                  >
                    <Trash2 size={15} color="var(--color-primary)" />
                  </button>

                  <div onClick={() => navigate(`/product/${pid}`)} className="w-full cursor-pointer" style={{ background: "var(--color-surface-muted)", padding: "8px" }}>
                    <div className="w-full aspect-square">
                      <img src={liveImageOf(item)} alt={item.title} loading="lazy" className="w-full h-full" style={{ objectFit: "cover", borderRadius: "8px" }} />
                    </div>
                  </div>

                  <div className="flex flex-col flex-1" style={{ padding: "12px" }}>
                    <div onClick={() => navigate(`/product/${pid}`)} className="cursor-pointer">
                      <p style={{ color: "var(--color-muted)", fontWeight: 600, fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.6px" }}>{item.category}</p>
                      <h3 style={{ color: "var(--color-ink)", fontWeight: 700, fontSize: "14px", lineHeight: "18px", marginTop: "4px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{item.title}</h3>
                    </div>
                    <div style={{ marginTop: "auto" }}>
                      <span style={{ color: "var(--color-ink)", fontWeight: 600, fontSize: "18px" }}>{money(item.price)}</span>
                      <button
                        onClick={() => { handleAddToCart(item); navigate("/cart") }}
                        className="w-full flex items-center justify-center"
                        style={{ marginTop: "8px", height: "36px", borderRadius: "9999px", background: "var(--color-primary)", color: "var(--color-inverse)", fontWeight: 700, fontSize: "12px", letterSpacing: "0.6px", textTransform: "uppercase", gap: "6px" }}
                      >
                        <ShoppingBag size={14} /> Add to Cart
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </main>
        )}
      </div>
    )
  }

  /* ============================================================
     DESKTOP LAYOUT (lg+) — SG Ecommerce / Fernhill artisanal redesign
  ============================================================ */
  return (
    <div
      style={{
        fontFamily: "'Plus Jakarta Sans', Inter, sans-serif",
        background: "#F5F1EB",
        minHeight: "100vh",
        color: "#1C1917",
      }}
    >
      <main style={{ maxWidth: "1280px", width: "100%", margin: "0 auto", padding: "88px 32px 64px", display: "flex", flexDirection: "column", gap: "40px" }}>

        {/* ── HEADER ── */}
        <header style={{ display: "flex", flexDirection: "column", gap: "16px", width: "100%" }}>
          {/* Breadcrumb */}
          <nav aria-label="Breadcrumb" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", height: "16px" }}>
            <button onClick={() => navigate("/")} style={{ color: "#78716C", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Home</button>
            <span style={{ color: "#A8A29E" }}>/</span>
            <button onClick={() => navigate("/products")} style={{ color: "#78716C", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Products</button>
            <span style={{ color: "#A8A29E" }}>/</span>
            <span style={{ color: "#1C1917", fontWeight: 500 }}>My Wishlist</span>
          </nav>

          {/* Title + Action Buttons row */}
          <div style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
            <div>
              <p style={{ fontSize: "12px", fontWeight: 600, color: "#7A8481", marginBottom: "4px" }}>
                You have {wishlistItems.length} item{wishlistItems.length !== 1 ? "s" : ""} saved in your wishlist.
              </p>
              <h1 style={{ fontSize: "30px", fontWeight: 800, lineHeight: "36px", letterSpacing: "-0.75px", color: "#1E2524", margin: 0 }}>
                My Wishlist
              </h1>
            </div>

            {wishlistItems.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                {/* Share Wishlist */}
                <button
                  onClick={handleShare}
                  style={{ height: "40px", padding: "0 16px", borderRadius: "12px", border: "1px solid #E7E2DA", background: "#fff", display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", fontWeight: 600, color: "#1C1917", cursor: "pointer" }}
                >
                  <Share2 size={16} style={{ color: "#1C1917" }} />
                  <span>Share Wishlist</span>
                </button>
                {/* Move All to Cart */}
                <button
                  onClick={handleMoveAll}
                  style={{ height: "40px", padding: "0 20px", borderRadius: "12px", background: "#064E3B", display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", fontWeight: 600, color: "#fff", cursor: "pointer", border: "none", boxShadow: "0 1px 4px rgba(6,78,59,0.18)" }}
                >
                  <ShoppingCart size={16} />
                  <span>Move All to Cart</span>
                </button>
              </div>
            )}
          </div>
        </header>

        {/* ── WISHLIST CARDS GRID ── */}
        <section aria-label="Wishlist Items" style={{ width: "100%" }}>
          {wishlistItems.length === 0 ? (
            /* Empty state */
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: "20px", padding: "80px 0" }}>
              <div style={{ width: "96px", height: "96px", borderRadius: "9999px", background: "rgba(255,255,255,0.7)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
                <ShoppingBag size={40} style={{ color: "#064E3B" }} />
              </div>
              <h2 style={{ fontWeight: 800, fontSize: "22px", color: "#1C1917", margin: 0 }}>Your wishlist is empty</h2>
              <p style={{ fontSize: "15px", color: "#78716C", margin: 0 }}>Save items you love to find them here later.</p>
              <button
                onClick={() => navigate("/products")}
                style={{ background: "#064E3B", color: "#fff", fontWeight: 700, fontSize: "15px", padding: "14px 36px", borderRadius: "12px", cursor: "pointer", border: "none" }}
              >
                Explore Products
              </button>
            </div>
          ) : loadingProducts ? (
            /* Skeleton grid */
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "24px" }}>
              {[...Array(4)].map((_, i) => (
                <div key={i} style={{ background: "#fff", border: "1px solid #E7E2DA", borderRadius: "16px", overflow: "hidden", height: "442px" }}>
                  <div style={{ height: "240px", background: "#ECEAE6", animation: "pulse 1.5s infinite" }} />
                  <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div style={{ height: "10px", width: "50%", background: "#E7E2DA", borderRadius: "4px" }} />
                    <div style={{ height: "14px", width: "80%", background: "#E7E2DA", borderRadius: "4px" }} />
                    <div style={{ height: "20px", width: "40%", background: "#E7E2DA", borderRadius: "4px" }} />
                    <div style={{ height: "44px", background: "#E7E2DA", borderRadius: "12px", marginTop: "12px" }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Main wishlist grid */
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "24px" }}>
              {wishlistItems.map((item) => {
                const pid = pidOf(item)
                const info = stockInfo(pid)
                const out = info.status === "OUT"
                const mrp = mrpOf(pid)
                const img = liveImageOf(item)
                const notified = alertedIds.includes(String(pid))
                return (
                  <article
                    key={pid}
                    style={{ background: "#fff", border: "1px solid #E7E2DA", borderRadius: "16px", display: "flex", flexDirection: "column", justifyContent: "space-between", overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", height: "442px" }}
                  >
                    {/* Image / graphic area */}
                    <div
                      style={{ height: "240px", background: "#ECEAE6", position: "relative", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px", overflow: "hidden", cursor: "pointer" }}
                      onClick={() => navigate(`/product/${pid}`)}
                    >
                      {/* Remove / heart button */}
                      <button
                        onClick={(e) => { e.stopPropagation(); if (window.confirm("Remove this item from your wishlist?")) handleRemove(pid) }}
                        aria-label="Remove from wishlist"
                        style={{ position: "absolute", top: "14px", right: "14px", width: "32px", height: "32px", borderRadius: "9999px", background: "rgba(255,255,255,0.92)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 4px rgba(0,0,0,0.12)", border: "none", cursor: "pointer", zIndex: 2 }}
                      >
                        {/* Filled heart icon — red */}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="#EF4444">
                          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                        </svg>
                      </button>

                      {/* Stock pill */}
                      {out ? (
                        <span style={{ position: "absolute", bottom: "12px", left: "12px", background: "#FEE2E2", color: "#DC2626", fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 8px", borderRadius: "4px" }}>
                          OUT OF STOCK
                        </span>
                      ) : info.status === "LOW" ? (
                        <span style={{ position: "absolute", bottom: "12px", left: "12px", background: "#FEF3C7", color: "#B45309", fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 8px", borderRadius: "4px" }}>
                          ONLY {info.left} LEFT
                        </span>
                      ) : (
                        <span style={{ position: "absolute", bottom: "12px", left: "12px", background: "#E7F8ED", color: "#1E7E34", fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 8px", borderRadius: "4px" }}>
                          IN STOCK
                        </span>
                      )}

                      {/* Product image */}
                      {img ? (
                        <img
                          src={img}
                          alt={item.title}
                          style={{ width: "100%", height: "100%", objectFit: "cover", position: "absolute", inset: 0 }}
                        />
                      ) : (
                        <div style={{ width: "80px", height: "80px", borderRadius: "12px", background: "#D6D3D1" }} />
                      )}

                      {/* Out-of-stock overlay */}
                      {out && (
                        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <span style={{ background: "#fff", borderRadius: "8px", padding: "6px 14px", fontWeight: 700, fontSize: "11px", letterSpacing: "1px", textTransform: "uppercase", color: "#1C1917" }}>
                            Out of Stock
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Product info + action */}
                    <div style={{ padding: "20px", display: "flex", flexDirection: "column", flex: 1, justifyContent: "space-between" }}>
                      <div>
                        <span style={{ display: "block", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "#A8A29E", letterSpacing: "0.07em", marginBottom: "4px" }}>
                          {item.brand || item.category || "PRODUCT"}
                        </span>
                        <h2
                          style={{ fontSize: "15px", fontWeight: 600, color: "#1C1917", margin: "0 0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
                          onClick={() => navigate(`/product/${pid}`)}
                        >
                          {item.title}
                        </h2>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <p style={{ fontSize: "20px", fontWeight: 600, color: "#1C1917", margin: 0 }}>{money(item.price)}</p>
                          {mrp > Number(item.price) && (
                            <p style={{ fontSize: "13px", color: "#A8A29E", textDecoration: "line-through", margin: 0 }}>{money(mrp)}</p>
                          )}
                        </div>
                      </div>

                      {out ? (
                        <button
                          onClick={() => handleNotify(pid)}
                          disabled={notified}
                          style={{ width: "100%", padding: "12px 16px", borderRadius: "12px", background: notified ? "#E7E2DA" : "#F5F1EB", border: "1px solid #E7E2DA", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", fontSize: "12px", fontWeight: 600, color: "#57534E", cursor: notified ? "default" : "pointer", opacity: notified ? 0.8 : 1, marginTop: "12px" }}
                        >
                          <Bell size={14} />
                          {notified ? "Notified ✓" : "Notify Me"}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleAddToCart(item)}
                          style={{ width: "100%", padding: "12px 16px", borderRadius: "12px", background: "#064E3B", border: "none", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", fontSize: "12px", fontWeight: 600, color: "#fff", cursor: "pointer", marginTop: "12px" }}
                        >
                          <ShoppingCart size={14} />
                          <span>Add to Cart</span>
                        </button>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        {/* ── DIVIDER ── */}
        {wishlistItems.length > 0 && <div style={{ borderTop: "1px solid #E7E2DA", width: "100%" }} />}

        {/* ── RECOMMENDED FOR YOU ── */}
        {wishlistItems.length > 0 && (
          <section aria-labelledby="recommended-heading" style={{ display: "flex", flexDirection: "column", gap: "20px", width: "100%" }}>
            {/* Section header */}
            <div style={{ display: "flex", flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
              <div>
                <h2 id="recommended-heading" style={{ fontSize: "22px", fontWeight: 600, color: "#1C1917", margin: "0 0 2px" }}>Recommended For You</h2>
                <p style={{ fontSize: "12px", color: "#78716C", margin: 0 }}>Complement your wishlist with artisanal picks.</p>
              </div>
              <button
                onClick={() => navigate("/products")}
                style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", fontWeight: 600, color: "#143B33", background: "none", border: "none", cursor: "pointer" }}
              >
                View Catalog <ArrowRight size={14} />
              </button>
            </div>

            {/* 4-col mini card grid */}
            {loadingRec ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "20px" }}>
                {[...Array(4)].map((_, i) => (
                  <div key={i} style={{ background: "#fff", border: "1px solid #E7E2DA", borderRadius: "16px", padding: "16px", height: "280px", animation: "pulse 1.5s infinite" }}>
                    <div style={{ height: "144px", background: "#F8F6F2", borderRadius: "12px", marginBottom: "16px" }} />
                    <div style={{ height: "10px", width: "50%", background: "#E7E2DA", borderRadius: "4px", marginBottom: "6px" }} />
                    <div style={{ height: "14px", width: "80%", background: "#E7E2DA", borderRadius: "4px" }} />
                  </div>
                ))}
              </div>
            ) : recommended.length === 0 ? (
              <p style={{ fontSize: "14px", color: "#78716C" }}>No recommendations right now.</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "20px" }}>
                {recommended.map((p) => {
                  const disc = Number(p.discount || 0)
                  const mrp = Number(p.price || 0)
                  const price = mrp - (mrp * disc) / 100
                  return (
                    <article
                      key={p.id}
                      style={{ background: "#fff", border: "1px solid #E7E2DA", borderRadius: "16px", padding: "16px", display: "flex", flexDirection: "column", justifyContent: "space-between", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}
                    >
                      {/* Illustration / image box */}
                      <div
                        style={{ height: "144px", background: "#F8F6F2", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "16px", overflow: "hidden", cursor: "pointer" }}
                        onClick={() => navigate(`/product/${p.id}`)}
                      >
                        {(p.thumbnail || p.image) ? (
                          <img src={p.thumbnail || p.image} alt={p.title || p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <div style={{ width: "48px", height: "48px", borderRadius: "8px", background: "#E7E2DA" }} />
                        )}
                      </div>
                      {/* Info */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <span style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#A8A29E" }}>{p.category}</span>
                        <h3
                          style={{ fontSize: "13px", fontWeight: 600, color: "#1C1917", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
                          onClick={() => navigate(`/product/${p.id}`)}
                        >
                          {p.title || p.name}
                        </h3>
                        <p style={{ fontSize: "15px", fontWeight: 600, color: "#1C1917", margin: 0 }}>{money(price)}</p>
                      </div>
                      {/* Add to cart button */}
                      <button
                        onClick={() => navigate(`/product/${p.id}`)}
                        style={{ marginTop: "12px", width: "100%", padding: "6px 12px", background: "#FAF8F5", border: "1px solid #E7E2DA", borderRadius: "8px", fontSize: "12px", fontWeight: 600, color: "#1C1917", display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", cursor: "pointer" }}
                      >
                        <span>+ View Product</span>
                      </button>
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        )}

      </main>
    </div>
  )
}

export default WishlistPage