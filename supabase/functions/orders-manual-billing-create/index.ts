// "Manual Billing" (admin ▸ Billing ▸ Manual Billing): friends / retailers / wholesale buyers at a manually-set price, as
// opposed to orders-billing-create (the catalog-priced walk-in counter) and orders-manual-create (a pasted WhatsApp message).
// Structured JSON like orders-billing-create, but the admin's own per-line price is TRUSTED instead of always re-priced from
// the catalog - the catalog lookup still runs, for stock / GST / SKU / variant resolution and so a line can't reference a
// product that does not exist.
import { handlePreflight, jsonResponse, methodNotAllowed, readBody } from "../_shared/cors.ts";
import { supabaseAdmin } from "../_shared/clients.ts";
import { requireAdmin, isFeatureKilled, isPromoExpired } from "../_shared/auth.ts";
import { getSellerState, loadPricingCatalog } from "../_shared/pricing.ts";
import { applyGstToItems, collectProductIds, priceCartItems, resolveInterState, round2, sumGstTotals } from "../_shared/cartPricing.ts";
import { createOrderTx, StockError } from "../_shared/orderWriter.ts";

const VALID_PAYMENT_METHODS = ["Cash", "UPI", "Card", "Bank Transfer", "Other"];
const VALID_CATEGORIES = ["friends", "retailer", "wholesale"];

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const methodErr = methodNotAllowed(req, ["POST"]);
  if (methodErr) return methodErr;

  const admin = supabaseAdmin();

  try {
    const auth = await requireAdmin(req, admin);
    if (!auth.user) return auth.error;

    if (await isFeatureKilled(admin, "orders")) {
      return jsonResponse(req, 503, { success: false, error: "Order creation is temporarily disabled." });
    }

    const { json: body } = await readBody(req);
    const {
      items,
      customerId = null,          // an existing profiles.id, resolved by the admin's saved-customer picker
      contactId = null,           // an existing billing_contacts.id (a saved friend / retailer / wholesale contact)
      customerName = "",
      customerPhone = "",
      customerEmail = "",
      customerCategory = "",      // tags the resolved profile (never a guest) - see #1 of the migration
      saveContact = false,        // true -> upsert a billing_contacts row for this name/phone/category (new or existing)
      paymentMethod = "Cash",
      paymentStatus = "paid",
      promoCode = "",
    } = body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return jsonResponse(req, 400, { success: false, error: "No items in the bill." });
    }
    const safeMethod = VALID_PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : "Cash";
    const safeStatus = paymentStatus === "pending" ? "pending" : "paid";
    const category = VALID_CATEGORIES.includes(String(customerCategory || "").toLowerCase()) ? String(customerCategory).toLowerCase() : "";

    // ── 1. Catalog-validated lines (stock, variant, GST, SKU), then the admin's own price per line ──
    const { productsById, variantsByProduct } = await loadPricingCatalog(admin, collectProductIds(items));
    const priced = priceCartItems(items, productsById, variantsByProduct, { honorDiscountExpiry: false });
    if (!priced.ok) {
      return jsonResponse(req, priced.status, { success: false, error: priced.error });
    }
    const resolvedItems = priced.lineItems.map((li, i) => {
      const override = Number(items[i]?.unitPrice);
      if (!(override >= 0)) return li;
      const finalPrice = round2(override);
      const discount = li.originalPrice > 0 && finalPrice < li.originalPrice
        ? round2(((li.originalPrice - finalPrice) / li.originalPrice) * 100)
        : 0;
      return { ...li, discount, finalPrice };
    });
    if (resolvedItems.some((it) => !(it.finalPrice > 0))) {
      return jsonResponse(req, 400, { success: false, error: "Every line needs a price greater than zero." });
    }
    const subtotalRounded = round2(resolvedItems.reduce((s, it) => s + it.finalPrice * it.quantity, 0));

    // ── 2. Promo code (optional, same lookup as the billing counter) ─────────
    let promoDiscount = 0;
    let appliedPromoCode = "";
    if (promoCode && typeof promoCode === "string" && promoCode.trim()) {
      const code = promoCode.trim().toUpperCase();
      try {
        const { data: pd } = await admin.from("promo_codes").select("*").eq("code", code).maybeSingle();
        if (pd && !isPromoExpired(pd.expiry_date)) {
          const value = Number(pd.value || 0);
          if (pd.type === "percent") promoDiscount = Math.round((subtotalRounded * value) / 100);
          else if (pd.type === "flat") promoDiscount = value;
          promoDiscount = Math.max(0, promoDiscount);
          appliedPromoCode = code;
        }
      } catch (e) {
        console.warn("[orders-manual-billing-create] promo lookup failed:", e);
      }
    }
    const total = Math.max(0, Math.round(subtotalRounded - promoDiscount));
    if (total <= 0) {
      return jsonResponse(req, 400, { success: false, error: "Bill total must be greater than zero." });
    }

    // ── 3. Resolve the customer: a saved profile (by id, else phone/email), else a saved contact, else a guest ──
    let userId: string | null = null;
    let userName = "", userEmail = "", userPhone = "";
    let userAddress: unknown = null;
    let isGuest = false;
    let buyerState = "";
    const phone = String(customerPhone || "").trim();
    const email = String(customerEmail || "").trim();

    if (customerId) {
      const { data: p } = await admin.from("profiles").select("*").eq("id", customerId).maybeSingle();
      if (p) {
        userId = p.id; userName = p.name || customerName || "Customer"; userEmail = p.email || email || ""; userPhone = p.phone || phone || "";
        userAddress = p.address ?? null; buyerState = p.address?.state || "";
      }
    }
    if (!userId && phone) {
      const { data: p } = await admin.from("profiles").select("*").eq("phone", phone).limit(1).maybeSingle();
      if (p) {
        userId = p.id; userName = p.name || customerName || "Customer"; userEmail = p.email || email || ""; userPhone = p.phone || phone;
        userAddress = p.address ?? null; buyerState = p.address?.state || "";
      }
    }
    if (!userId && email) {
      const { data: p } = await admin.from("profiles").select("*").eq("email", email).limit(1).maybeSingle();
      if (p) {
        userId = p.id; userName = p.name || customerName || "Customer"; userEmail = p.email || email; userPhone = p.phone || phone || "";
        userAddress = p.address ?? null; buyerState = p.address?.state || "";
      }
    }
    if (userId && category) {
      // a registered customer found above can be tagged with the category chosen on this bill (never downgraded silently - the
      // admin picked it on this screen)
      await admin.from("profiles").update({ channel: category.charAt(0).toUpperCase() + category.slice(1) }).eq("id", userId);
    }
    if (!userId) {
      // no storefront account - bill against a saved contact instead (billing_contacts.id is NOT a profiles.id / orders.user_id)
      isGuest = true;
      userName = customerName || "Customer";
      userEmail = email;
      userPhone = phone;
      if (contactId) {
        const { data: c } = await admin.from("billing_contacts").select("*").eq("id", contactId).maybeSingle();
        if (c) { userName = c.name || userName; userEmail = c.email || userEmail; userPhone = c.phone || userPhone; userAddress = c.address ?? null; }
      }
    }

    if (saveContact && !userId && category && userName) {
      // upsert by phone when given (billing_contacts_phone_idx), else always a new row - never overwrites a different contact by name alone
      const row = { name: userName, phone: userPhone || null, email: userEmail || null, category };
      if (phone) await admin.from("billing_contacts").upsert(row, { onConflict: "phone" });
      else await admin.from("billing_contacts").insert(row);
    }

    const sellerState = await getSellerState(admin);
    const isInterState = resolveInterState(buyerState, sellerState);
    const gstItems = applyGstToItems(resolvedItems, isInterState);
    const gstTotals = sumGstTotals(gstItems);
    const totalItems = resolvedItems.reduce((s, it) => s + it.quantity, 0);

    // ── 4. Write the order (stock re-validated inside the RPC) ───────────────
    const orderId = `mb_${crypto.randomUUID()}`;
    try {
      await createOrderTx(admin, {
        orderId,
        userId,
        items: gstItems,
        orderStatus: "placed",       // unlike the walk-in counter, a manual-billing sale is not assumed to be handed over on the spot
        paymentStatus: safeStatus,
        paymentMethod: safeMethod,
        source: "manual_billing",
        customerName: userName,
        customerEmail: userEmail,
        customerPhone: userPhone,
        address: userAddress,
        subtotal: subtotalRounded,
        shipping: 0,
        cgst: gstTotals.totalCgst,
        sgst: gstTotals.totalSgst,
        igst: gstTotals.totalIgst,
        promoCode: appliedPromoCode,
        promoDiscount,
        total,
      });
    } catch (e) {
      if (e instanceof StockError) {
        return jsonResponse(req, 409, { success: false, error: e.message });
      }
      throw e;
    }

    return jsonResponse(req, 200, {
      success: true,
      orderId,
      order: {
        orderId, id: orderId, userId, userName, userEmail, userPhone,
        subtotal: subtotalRounded, promoDiscount, promoCode: appliedPromoCode, total, totalItems,
        paymentMethod: safeMethod, paymentStatus: safeStatus, orderStatus: "placed", source: "manual_billing",
        createdAt: new Date().toISOString(), products: gstItems, isGuest,
      },
    });
  } catch (err) {
    console.error("[orders-manual-billing-create] failed:", err);
    if (err instanceof StockError) {
      return jsonResponse(req, 409, { success: false, error: err.message });
    }
    return jsonResponse(req, 500, { success: false, error: "Failed to create bill" });
  }
});