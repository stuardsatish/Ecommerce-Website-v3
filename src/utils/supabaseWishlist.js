import { supabase } from "../context/SupabaseConfig"

export const addWishlistItem = async (uid, product) => {
  if (!uid) return
  const { error } = await supabase.from("wishlist_items").upsert(
    {
      user_id: uid,
      product_id: String(product.id),
      title: product.title || "",
      image: product.thumbnail || product.image || "",
      price: Number(product.price) || 0,
      category: product.category || "",
    },
    { onConflict: "user_id,product_id" }
  )
  if (error) console.error("Wishlist add error:", error)

  // Silently register a price alert so the DB trigger sends a price-drop
  // notification if the admin lowers the effective price later.
  // set_price_alert() is SECURITY DEFINER and upserts on (user_id, product_id),
  // so calling it twice for the same item is safe.
  try {
    await supabase.rpc("set_price_alert", { p_product_id: String(product.id) })
  } catch (e) {
    // Non-fatal: the wishlist item is already saved. The user just won't get
    // automatic price-drop notifications for this product.
    console.warn("Could not set price alert for wishlist item:", e?.message || e)
  }
}

export const removeWishlistItem = async (uid, productId) => {
  if (!uid) return
  const { error } = await supabase
    .from("wishlist_items")
    .delete()
    .eq("user_id", uid)
    .eq("product_id", String(productId))
  if (error) console.error("Wishlist remove error:", error)
}
