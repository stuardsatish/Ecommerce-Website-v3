import React, { useState, useEffect } from "react";
import { useSelector, useDispatch } from "react-redux";
import { useNavigate } from "react-router-dom";
import {
  addCart,
  removeCart,
  deleteCart,
  clearCart,
} from "../../context/CartSlice";
import { toast } from "react-toastify";
import {
  Minus,
  Plus,
  ShoppingBag,
  ArrowLeft,
  Package,
  Trash2,
  ArrowRight,
  Lock,
  Headphones,
  ExternalLink,
  CreditCard,
  Banknote,
  X,
} from "lucide-react";
import { supabase } from "../../context/SupabaseConfig";
import { mapProductRows } from "../../utils/supabaseProducts";
import { upsertCartItem, removeCartItem, decrementOrRemoveCartItem, clearCartItems, nextAddQuantity, nextRemoveQuantity } from "../../utils/supabaseCart";
import useIsMobile from "../../hooks/useIsMobile";
import {
  loadRazorpayScript,
  createRazorpayOrder,
  verifyRazorpayPayment,
  createCodOrder,
} from "../../utils/razorpay";
import { validatePromoCode } from "../../utils/promo";
import PolicyLinks from "../../components/Common/PolicyLinks";
import { formatCurrency } from "../../utils/pricing";
import { addressFromProfile } from "../../utils/addresses";
import DeliverToCard from "../../components/Address/DeliverToCard";
import AddressPicker from "../../components/Address/AddressPicker";
import AddressFormModal from "../../components/Address/AddressFormModal";
import {
  Bookmark,
  Tag,
  AlertTriangle,
  ShoppingCart as CartIcon,
} from "lucide-react";
import {
  listSavedItems,
  saveForLater,
  moveSavedToCart,
  removeSavedItem,
  listAvailableCoupons,
  describeCoupon,
} from "../../services/savedItems";

const CartPage = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const cartItems = useSelector((state) => state.cart.cartItems);
  const user = useSelector((state) => state.user.user);

  const [isProcessing, setIsProcessing] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [addressPickerOpen, setAddressPickerOpen] = useState(false);
  const [addressFormOpen, setAddressFormOpen] = useState(false);
  const [paymentSettings, setPaymentSettings] = useState({
    whatsappPayment: true,
    razorpayPayment: true,
    codPayment: true,
  });
  const [shippingConfig, setShippingConfig] = useState({
    freeShippingThreshold: 500,
    shippingCost: 49,
  });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [gstEnabled, setGstEnabled] = useState(true);
  // Gift wrap admin settings (loaded from Supabase giftWrapSettings row)
  const [giftWrapConfig, setGiftWrapConfig] = useState({ giftWrapEnabled: false, giftWrapFree: true, giftWrapCost: 0 });

  useEffect(() => {
    let active = true;
    const fetchSettings = async () => {
      try {
        const { data: rows, error } = await supabase
          .from("settings")
          .select("id, data")
          .in("id", ["paymentSettings", "shippingSettings", "gstSettings", "giftWrapSettings"]);
        if (error) throw error;
        const byId = {};
        (rows || []).forEach((r) => { byId[r.id] = r.data || {}; });
        if (active) {
          const pd = byId.paymentSettings;
          if (pd) {
            // COD defaults to enabled for rows created before the flag existed.
            setPaymentSettings({ ...pd, codPayment: pd.codPayment !== false });
          }
          const sd = byId.shippingSettings;
          if (sd) {
            setShippingConfig({
              freeShippingThreshold: typeof sd.freeShippingThreshold === "number" ? sd.freeShippingThreshold : 500,
              shippingCost: typeof sd.shippingCost === "number" ? sd.shippingCost : 49,
            });
          }
          const gd = byId.gstSettings;
          if (gd) {
            setGstEnabled(gd.gstEnabled !== false);
          }
          const gwd = byId.giftWrapSettings;
          if (gwd) {
            setGiftWrapConfig({ giftWrapEnabled: gwd.giftWrapEnabled === true, giftWrapFree: gwd.giftWrapFree !== false, giftWrapCost: Number(gwd.giftWrapCost || 0) });
          }
        }
      } catch (error) {
        console.error("Error fetching settings:", error);
      } finally {
        if (active) {
          setSettingsLoading(false);
        }
      }
    };
    fetchSettings();
    return () => {
      active = false;
    };
  }, []);

  const isCheckoutDisabled = !paymentSettings.whatsappPayment && !paymentSettings.razorpayPayment && !paymentSettings.codPayment;

  // Mobile design renders below the `lg` breakpoint; the desktop redesign at lg+.
  const isMobile = useIsMobile(1024);

  /* ---------- DESKTOP REDESIGN STATE ---------- */
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromo, setAppliedPromo] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(true);

  // Phase 5A: Save for later
  const [savedItems, setSavedItems] = useState([]);
  const [savingId, setSavingId] = useState(null);
  const [movingId, setMovingId] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  // Phase 5A: Coupons
  const [coupons, setCoupons] = useState([]);
  const [couponsLoaded, setCouponsLoaded] = useState(false);
  const [showCoupons, setShowCoupons] = useState(false);

  // Phase 5.11: Gift wrap
  const [giftWrap, setGiftWrap] = useState(false);
  const [giftMessage, setGiftMessage] = useState('');

  // Phase 5A: Price-change notice
  const [priceChanges, setPriceChanges] = useState({});
  const [acknowledgedChanges, setAcknowledgedChanges] = useState(false);
  const hasAnyPriceChange = Object.keys(priceChanges).length > 0 && !acknowledgedChanges;

  // NOTE: a `total` here used to hold the raw MRP sum
  // (`sum(price * quantity)`, no discounts/shipping/promo). Its only consumer
  // was the mobile sticky bar, which was showing the wrong amount because of
  // it; that now uses `orderTotal` below, leaving this with no callers, so it
  // was removed rather than left as a second, wrong notion of "total".
  const totalItems = cartItems.reduce((acc, item) => acc + item.quantity, 0);

  /* ---------- ORDER SUMMARY (derived from cart) ---------- */
  // Local alias for the shared formatter, so this file's ~20 existing
  // `money(...)` call sites keep working while the symbol itself lives in one
  // place (`utils/pricing.js`).
  const money = formatCurrency;

  const isDiscountActive = (item) => {
    if (!item) return false;
    const disc = Number(item.discount || 0);
    if (disc <= 0) return false;
    if (item.discountExpiry) {
      const val = item.discountExpiry;
      let expiry = NaN;
      if (typeof val === "string") {
        expiry = new Date(val).getTime();
        if (isNaN(expiry)) {
          const cleanStr = val.replace(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+(AM|PM)/i, "$1 $2 $3");
          expiry = new Date(cleanStr).getTime();
        }
      } else if (val?.toDate) {
        expiry = val.toDate().getTime();
      } else if (typeof val === "number") {
        expiry = val;
      }
      if (!isNaN(expiry) && Date.now() > expiry) {
        return false;
      }
    }
    return true;
  };

  const subtotal = cartItems.reduce((sum, item) => {
    const price = Number(item.price || 0);
    const quantity = Number(item.quantity || 0);
    const discount = isDiscountActive(item) ? Number(item.discount || 0) : 0;
    const discountedPrice = price - (price * discount) / 100;

    return sum + discountedPrice * quantity;
  }, 0);

  // Calculate promo discount dynamically
  let promoDiscount = 0;
  if (appliedPromo) {
    let isExpired = false;
    if (appliedPromo.expiryDate) {
      const expiry = new Date(appliedPromo.expiryDate).getTime();
      if (Date.now() > expiry) {
        isExpired = true;
      }
    }
    if (!isExpired) {
      promoDiscount = appliedPromo.type === "percent"
        ? Math.round((subtotal * Number(appliedPromo.value || 0)) / 100)
        : Number(appliedPromo.value || 0);
    }
  }

  const shippingEstimate = subtotal >= shippingConfig.freeShippingThreshold ? 0 : shippingConfig.shippingCost;
  // Gift wrap charge: 0 if not enabled, 0 if free, or the configured cost
  const giftWrapCharge = (giftWrap && giftWrapConfig.giftWrapEnabled && !giftWrapConfig.giftWrapFree) ? Number(giftWrapConfig.giftWrapCost || 0) : 0;
  // Mirror the server's rounding in functions/routes/payment.js exactly (round the
  // subtotal to whole rupees BEFORE adding shipping/promo) — otherwise this total
  // can show paise the server never charges, since Razorpay is always billed a
  // rounded whole-rupee amount.
  const subtotalRounded = Math.round(subtotal);
  const orderTotal = Math.max(0, Math.round(subtotalRounded + shippingEstimate + giftWrapCharge - promoDiscount));
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        let { data, error } = await supabase
          .from("products")
          .select("*")
          .order("rating", { ascending: false })
          .limit(8);
        if (error) {
          ({ data, error } = await supabase.from("products").select("*").limit(8));
          if (error) throw error;
        }
        if (active) setSuggestions(mapProductRows(data));
      } catch (e) {
        console.log("suggestions fetch failed:", e);
      } finally {
        if (active) setLoadingSuggestions(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Exclude products already in the cart; show up to 4.
  const suggestionList = suggestions
    .filter((p) => !cartItems.some((c) => c.id === p.id))
    .slice(0, 4);

  // Phase 5A: Load saved items + coupons on mount
  useEffect(() => {
    listSavedItems().then(setSavedItems).catch(() => { });
    listAvailableCoupons()
      .then((list) => { setCoupons(list); setCouponsLoaded(true); })
      .catch(() => setCouponsLoaded(true));
  }, []);

  // Phase 5A: Price-change detection on mount
  useEffect(() => {
    if (!cartItems.length) return;
    let active = true;
    const productIds = [...new Set(cartItems.map((i) => i.productId || String(i.id || '').split('_var_')[0]).filter(Boolean))];
    supabase
      .from("products")
      .select("id,price,discount,discount_expiry,variants")
      .in("id", productIds)
      .then(({ data }) => {
        if (!active || !data) return;
        const byId = {};
        data.forEach((p) => { byId[p.id] = p; });
        const changes = {};
        cartItems.forEach((item) => {
          const pid = item.productId || String(item.id || '').split('_var_')[0];
          const live = byId[pid];
          if (!live) return;
          // The line's OWN option: a variant line is compared with THAT variant's live price, a main / single line with
          // the product's price. (The old check compared every line with the parent's price, so every variant line
          // raised a false "price changed" notice.)
          let liveMrp = Number(live.price || 0);
          if (item.variant_id) {
            const vObj = Array.isArray(live.variants) ? live.variants.find((v) => String(v.id) === String(item.variant_id)) : null;
            if (!vObj) return;                 // variant no longer sold: the line is flagged unavailable instead
            liveMrp = Number(vObj.price);
          }
          const liveDisc = isDiscountActive({ discount: live.discount, discountExpiry: live.discount_expiry }) ? Number(live.discount || 0) : 0;
          const livePrice = liveMrp - (liveMrp * liveDisc) / 100;
          // What the customer SAW when they added it = the cart row's snapshot, not the already-refreshed live value
          const storedMrp = item.storedPrice != null ? Number(item.storedPrice) : Number(item.price || 0);
          const storedDiscVal = item.storedDiscount != null ? Number(item.storedDiscount) : 0;
          const storedDisc = isDiscountActive({ discount: storedDiscVal, discountExpiry: item.storedDiscountExpiry || '' }) ? storedDiscVal : 0;
          const storedPrice = storedMrp - (storedMrp * storedDisc) / 100;
          if (Math.abs(livePrice - storedPrice) > 1) {
            const key = String(item.compound_id || item.id);
            changes[key] = { storedPrice, livePrice, liveDiscount: live.discount || 0, liveExpiry: live.discount_expiry || null };
          }
        });
        setPriceChanges(changes);
      })
      .catch(() => { });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- PROMO CODE ---------- */
  const handleApplyPromo = async () => {
    const code = promoCode.trim().toUpperCase();
    if (!code) return;
    try {
      // Validated server-side (promoCodes is no longer client-readable). The
      // authoritative discount is recomputed again at checkout.
      const data = await validatePromoCode(code, subtotal);

      setAppliedPromo({
        code: data.code || code,
        type: data.type || "percent",
        value: Number(data.value || 0),
      });

      toast.success(
        data.discount > 0 ? `Promo applied: -${money(data.discount)}` : "Promo applied",
      );
    } catch (e) {
      setAppliedPromo(null);
      toast.error(e.message || "Could not apply promo code");
    }
  };

  /* Remove an item entirely (desktop "Remove" button). */
  const handleDeleteItem = (id) => {
    if (!window.confirm("Remove this item from your cart?")) return;
    const item = cartItems.find((x) => String(x.id || x.compound_id) === String(id));
    dispatch(deleteCart(id));
    removeCartItem(user?.uid, item || id);
  };

  /* ADD CART */

  const handleAddCart = (item) => {
    const qty = nextAddQuantity(cartItems, item.id || item.compound_id);
    dispatch(addCart({ ...item, qtyToAdd: 1 }));
    upsertCartItem(user?.uid, item, qty);
  };

  /* REMOVE CART */

  const handleRemoveCart = (id) => {
    const item = cartItems.find((x) => String(x.id || x.compound_id) === String(id));
    const qty = nextRemoveQuantity(cartItems, id);
    if (qty <= 0 && !window.confirm("Remove this item from your cart?")) return;
    dispatch(removeCart(id));
    decrementOrRemoveCartItem(user?.uid, item || id, qty);
  };

  /* Empty the cart entirely (UI "Clear Cart" buttons — not the post-checkout
     clears below, which the server already handles once orders are wired up). */
  const handleClearCart = () => {
    if (!window.confirm("Remove all items from your cart?")) return;
    dispatch(clearCart());
    clearCartItems(user?.uid);
  };

  /* PLACE ORDER — the server prices the cart, takes payment, and writes the
     order. The client sends only { productId, quantity } and never touches the
     order/stock/analytics docs (those are admin-only at the rules level). */

  const placeOrder = async () => {
    try {
      if (!user?.uid) {
        toast.error("Please login first");
        return;
      }
      if (!cartItems.length) {
        toast.error("Your cart is empty.");
        return;
      }

      /* Require a verified email before checkout (also enforced server-side). */
      const { data: freshAuth } = await supabase.auth.getUser();
      if (!freshAuth?.user?.email_confirmed_at) {
        try {
          await supabase.auth.resend({ type: "signup", email: user.email });
        } catch (e) {
          console.log("verify email send:", e);
        }
        toast.error(
          "Please verify your email before checking out — we just sent you a verification link.",
        );
        return;
      }

      setIsProcessing(true);

      /* Prefill info only — NOT prices. Profile data is already in Redux. */
      const userData = user;

      /* 1) Load the Razorpay checkout script */
      const scriptOk = await loadRazorpayScript();
      if (!scriptOk) {
        throw new Error(
          "Couldn't reach Razorpay. Check your connection and try again.",
        );
      }

      /* 2) Server validates each item against the catalog and computes the amount.
            promoCode is sent as a plain string; the server validates it against
            Firestore and applies the discount — the client never determines the value. */
      const rzpOrder = await createRazorpayOrder({
        items: cartItems.map((i) => {
          const rawId = String(i.id || i.compound_id || "");
          const cleanPid = i.productId || (rawId.includes("_var_") ? rawId.split("_var_")[0] : rawId);
          const cleanVid = i.variant_id || (rawId.includes("_var_") ? "var_" + rawId.split("_var_")[1] : null);
          return {
            productId: cleanPid,
            variantId: cleanVid,
            variant_name: i.variant_name || null,
            quantity: i.quantity,
          };
        }),
        promoCode: appliedPromo ? appliedPromo.code : "",
        gift: { wrap: giftWrap, message: giftMessage.trim() },
      });

      /* 3) Open checkout. The order is written server-side only after verification. */
      const rzp = new window.Razorpay({
        key: rzpOrder.keyId,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        name: "Nexus Commerce",
        description: `Order • ${totalItems} item(s)`,
        order_id: rzpOrder.orderId,
        prefill: {
          name: userData.name || "",
          email: userData.email || "",
          contact: userData.phone || "",
        },
        theme: { color: "var(--color-primary)" },
        handler: async (response) => {
          try {
            /* 4) Server verifies the signature AND writes the order from its own
                  validated copy — the client can't influence price or contents here. */
            const verifyResult = await verifyRazorpayPayment({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });


            dispatch(clearCart());
            toast.success("Payment successful — order placed ", {
              position: "bottom-right",
              autoClose: 3000,
              theme: "dark",
            });
            navigate("/products");
          } catch (err) {
            console.error("VERIFY/ORDER ERROR:", err);
            toast.error(err.message || "Payment could not be verified.");
          } finally {
            setIsProcessing(false);
          }
        },
        modal: {
          ondismiss: () => {
            setIsProcessing(false);
            toast.info("Payment cancelled.");
          },
        },
      });

      rzp.on("payment.failed", (resp) => {
        setIsProcessing(false);
        toast.error(
          resp?.error?.description || "Payment failed. Please try again.",
        );
      });

      rzp.open();
    } catch (error) {
      console.error("ORDER ERROR:", error);
      toast.error(error.message);
      setIsProcessing(false);
    }
  };

  // Phase 5A: Save for later handlers
  const handleSaveForLater = async (cartItem) => {
    const key = String(cartItem.compound_id || cartItem.id);
    setSavingId(key);
    try {
      await saveForLater(cartItem, user?.uid, (item) => {
        dispatch(deleteCart(item.id || item.compound_id));
        removeCartItem(user?.uid, item);
      });
      setSavedItems(await listSavedItems());
      toast.success(`${cartItem.title || "Item"} saved for later`);
    } catch (err) {
      toast.error(err.message || "Could not save for later.");
    } finally {
      setSavingId(null);
    }
  };

  const handleMoveSavedToCart = async (savedItem) => {
    const key = String(savedItem.compound_id || savedItem.id);
    setMovingId(key);
    try {
      const result = await moveSavedToCart(savedItem, user?.uid);
      setSavedItems(await listSavedItems());
      dispatch(addCart({ ...savedItem, id: savedItem.compound_id || savedItem.id, qtyToAdd: result.clamped ? result.clampedTo : savedItem.quantity }));
      if (result.clamped) toast.info(`Only ${result.clampedTo} left in stock — quantity adjusted.`);
      else toast.success(`${savedItem.title || "Item"} moved to cart`);
    } catch (err) {
      toast.error(err.message || "Could not move to cart.");
    } finally {
      setMovingId(null);
    }
  };

  const handleRemoveSaved = async (savedItem) => {
    if (!window.confirm("Remove this saved item?")) return;
    const key = String(savedItem.compound_id || savedItem.id);
    setRemovingId(key);
    try {
      await removeSavedItem(savedItem);
      setSavedItems(await listSavedItems());
    } catch (err) {
      toast.error(err.message || "Could not remove.");
    } finally {
      setRemovingId(null);
    }
  };

  const handleApplyCouponFromList = (coupon) => {
    setPromoCode(coupon.code);
    setShowCoupons(false);
    setTimeout(() => handleApplyPromo(), 0);
  };

  const handleAcknowledgePriceChanges = async () => {
    if (user?.uid) {
      await Promise.all(
        cartItems
          .filter((item) => priceChanges[String(item.compound_id || item.id)])
          .map((item) => {
            const ch = priceChanges[String(item.compound_id || item.id)];
            return upsertCartItem(user.uid, {
              productId: item.productId || String(item.id || '').split('_var_')[0],
              variantId: item.variant_id, variant_name: item.variant_name,
              title: item.title, image: item.thumbnail || item.image,
              category: item.category, price: item.price,
              discount: ch.liveDiscount, discountExpiry: ch.liveExpiry,
            }, item.quantity);
          })
      ).catch(() => { });
    }
    setAcknowledgedChanges(true);
    setPriceChanges({});
  };

  const handleCheckoutClick = () => {
    if (!cartItems.length) {
      toast.error("Your cart is empty.");
      return;
    }
    // A line whose variant was deactivated/deleted (or whose main product is no longer sold on its own) cannot be bought;
    // the server would refuse it, so say so here instead of failing after payment starts.
    const blocked = cartItems.find((i) => i.unavailable);
    if (blocked) {
      toast.error(`${blocked.title}${blocked.variant_name ? ` (${blocked.variant_name})` : ""} is no longer available — please remove it from your cart.`);
      return;
    }
    setShowPaymentModal(true);
  };

  const handleRazorpayOrder = () => {
    setShowPaymentModal(false);
    placeOrder();
  };

  /* CASH ON DELIVERY — the server prices the cart, validates the delivery
     address + stock, and writes the order (paymentMethod:"COD",
     paymentStatus:"pending"). The client sends only { productId, quantity }. */
  const handleCodOrder = async () => {
    try {
      setShowPaymentModal(false);

      if (!user?.uid) {
        toast.error("Please login first to place an order");
        return;
      }
      if (!cartItems.length) {
        toast.error("Your cart is empty.");
        return;
      }

      /* Require a verified email (also enforced server-side). */
      const { data: freshAuth } = await supabase.auth.getUser();
      if (!freshAuth?.user?.email_confirmed_at) {
        try {
          await supabase.auth.resend({ type: "signup", email: user.email });
        } catch (e) {
          console.log("verify email send:", e);
        }
        toast.error(
          "Please verify your email before checking out — we just sent you a verification link.",
        );
        return;
      }

      /* Address must be on file before COD (server rejects otherwise). */
      const addr = user.address;
      const street = typeof addr === "object" ? addr?.street : addr;
      if (!street || !String(street).trim()) {
        toast.error(
          "Please add a delivery address before selecting Cash on Delivery.",
          { autoClose: 5000 },
        );
        setAddressFormOpen(true);
        return;
      }

      setIsProcessing(true);

      await createCodOrder({
        items: cartItems.map((i) => {
          const rawId = String(i.id || i.compound_id || "");
          const cleanPid = i.productId || (rawId.includes("_var_") ? rawId.split("_var_")[0] : rawId);
          const cleanVid = i.variant_id || (rawId.includes("_var_") ? "var_" + rawId.split("_var_")[1] : null);
          return {
            productId: cleanPid,
            variantId: cleanVid,
            variant_name: i.variant_name || null,
            quantity: i.quantity,
          };
        }),
        promoCode: appliedPromo ? appliedPromo.code : "",
        gift: { wrap: giftWrap, message: giftMessage.trim() },
      });

      dispatch(clearCart());
      toast.success("Order placed successfully with Cash on Delivery!", {
        position: "bottom-right",
        autoClose: 4000,
        theme: "dark",
      });
      navigate("/userorders");
    } catch (err) {
      console.error("COD Order Error:", err);
      toast.error(err.message || "Could not place order.");
    } finally {
      setIsProcessing(false);
    }
  };

  const sendOrderToWhatsApp = async () => {
    try {
      setShowPaymentModal(false);
      setIsProcessing(true);

      const customerName = user?.name || "";
      const customerEmail = user?.email || "";
      const customerPhone = user?.phone || "NA";
      const customerID = user?.uid || "";

      let itemsStr = "";
      cartItems.forEach((item, index) => {
        const mrp = Number(item.price || 0);
        const discount = isDiscountActive(item) ? Number(item.discount || 0) : 0;
        const discountedPrice = Number((mrp - (mrp * discount) / 100).toFixed(2));
        const variantLabel = item.variant_name ? ` [${item.variant_name}]` : "";
        if (discount > 0) {
          itemsStr += `${index + 1}. ${item.title}${variantLabel}\n Ref: ${item.productId || ""}|${item.variant_id || ""}\n Quantity: ${item.quantity}\n MRP: ${money(mrp)}\n Discount: ${discount}%\n Discounted Price: ${money(discountedPrice)}\n\n`;
        } else {
          itemsStr += `${index + 1}. ${item.title}${variantLabel}\n Ref: ${item.productId || ""}|${item.variant_id || ""}\n Quantity: ${item.quantity}\n MRP: ${money(mrp)}\n Discounted Price: ${money(mrp)}\n\n`;
        }
      });

      const totalItems = cartItems.reduce(
        (acc, item) => acc + item.quantity,
        0,
      );

      const promoLine = promoDiscount > 0
        ? `Promo Code : ${appliedPromo?.code || "Applied"}\nPromo Discount : ${money(promoDiscount)}\n`
        : "";

      const message = `Hello,

I would like to place the following order.

**Customer Details:**

Customer ID: ${customerID}
Customer Name: ${customerName}
Email: ${customerEmail}
Phone: ${customerPhone}


**Items:**

${itemsStr}
Total Items : ${totalItems}
Subtotal : ${money(subtotal)}
Shipping : ${money(shippingEstimate)}
Gift Wrap : ${giftWrap ? "Yes" : "No"}
${giftWrap ? `Gift Wrap Charge : ${money(giftWrapCharge)}\nGift Message : ${giftMessage.trim().replace(/[\r\n]+/g, " ") || "None"}\n` : ""}
${promoLine}Total Amount : ${money(orderTotal)}

Thank you.`;


      const encodedText = encodeURIComponent(message);
      const url = `https://wa.me/919940574522?text=${encodedText}`;
      window.open(url, "_blank");
    } catch (error) {
      console.error("WhatsApp order failed:", error);
      toast.error("Failed to generate WhatsApp order. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const paymentModal = showPaymentModal && (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center p-4"
      style={{
        background: "var(--color-overlay)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
      onClick={() => setShowPaymentModal(false)}
    >
      <div
        className="bg-surface w-full max-w-[400px] rounded-2xl p-6 relative overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        style={{
          boxShadow:
            "0px 20px 25px -5px rgba(0,0,0,0.1), 0px 10px 10px -5px rgba(0,0,0,0.04)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          onClick={() => setShowPaymentModal(false)}
          className="absolute top-4 right-4 text-muted hover:text-body transition-colors"
          style={{ cursor: "pointer", background: "none", border: "none" }}
          aria-label="Close"
        >
          <X size={20} />
        </button>

        {/* Title & Subtitle */}
        <div className="text-center mb-6 pt-2">
          <h3
            className="text-xl font-bold text-ink"
            style={{ fontFamily: "Inter, sans-serif" }}
          >
            Choose Payment Method
          </h3>
          <p className="text-sm text-muted mt-1 font-medium">
            Select how you would like to place your order.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col gap-3">
          {/* Button 1: Razorpay */}
          {paymentSettings.razorpayPayment && (
            <button
              onClick={handleRazorpayOrder}
              className="flex items-center justify-between w-full p-4 rounded-xl text-inverse transition-all transform hover:scale-[1.02] active:scale-[0.98]"
              style={{
                background: "var(--color-primary)",
                boxShadow: "0px 4px 12px color-mix(in srgb, var(--color-primary) 20%, transparent)",
                fontWeight: 700,
                fontSize: "15px",
                cursor: "pointer",
                border: "none",
              }}
            >
              <div className="flex items-center gap-3">
                <CreditCard size={20} />
                <span>Pay with Razorpay</span>
              </div>
              <ArrowRight size={16} />
            </button>
          )}

          {/* Button 2: WhatsApp */}
          {paymentSettings.whatsappPayment && (
            <button
              onClick={sendOrderToWhatsApp}
              className="flex items-center justify-between w-full p-4 rounded-xl text-inverse transition-all transform hover:scale-[1.02] active:scale-[0.98]"
              style={{
                background: "#25D366",
                boxShadow: "0px 4px 12px rgba(37, 211, 102, 0.2)",
                fontWeight: 700,
                fontSize: "15px",
                cursor: "pointer",
                border: "none",
              }}
            >
              <div className="flex items-center gap-3">
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="currentColor"
                >
                  <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.514 2.266 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.502-5.724-1.455L0 24zm6.59-4.846c1.6.95 3.188 1.449 4.825 1.451 5.436 0 9.86-4.37 9.864-9.799.002-2.63-1.023-5.101-2.885-6.963C16.79 1.982 14.321.958 11.7.958c-5.44 0-9.866 4.372-9.87 9.802 0 1.763.465 3.486 1.348 5.021l-.988 3.61 3.738-.973zm11.758-5.321c-.305-.153-1.808-.891-2.088-.992-.28-.102-.485-.153-.688.153-.203.305-.788.992-.966 1.196-.177.203-.355.228-.66.076-.305-.153-1.288-.475-2.455-1.517-.908-.81-1.52-1.81-1.698-2.115-.177-.305-.019-.47.133-.621.137-.136.305-.355.457-.533.153-.177.203-.305.305-.508.102-.203.05-.381-.025-.533-.076-.153-.688-1.657-.942-2.269-.248-.599-.5-.517-.688-.527-.178-.009-.381-.01-.584-.01-.203 0-.533.076-.813.381-.28.305-1.067 1.042-1.067 2.541 0 1.498 1.092 2.946 1.244 3.149.153.203 2.15 3.284 5.207 4.601.727.314 1.294.502 1.737.643.73.232 1.393.199 1.918.121.584-.087 1.808-.737 2.062-1.449.254-.712.254-1.322.178-1.449-.076-.127-.28-.203-.585-.356z" />
                </svg>
                <span>Order via WhatsApp</span>
              </div>
              <ArrowRight size={16} />
            </button>
          )}

          {/* Button 3: Cash on Delivery */}
          {paymentSettings.codPayment && (
            <button
              onClick={handleCodOrder}
              className="flex items-center justify-between w-full p-4 rounded-xl text-inverse transition-all transform hover:scale-[1.02] active:scale-[0.98]"
              style={{
                background: "#1E293B",
                boxShadow: "0px 4px 12px rgba(30, 41, 59, 0.2)",
                fontWeight: 700,
                fontSize: "15px",
                cursor: "pointer",
                border: "none",
              }}
            >
              <div className="flex items-center gap-3">
                <Banknote size={20} style={{ color: "#34D399" }} />
                <div className="text-left">
                  <span>Cash on Delivery</span>
                  <span className="block text-[11px] font-normal" style={{ color: "#CBD5E1" }}>Pay cash when your order arrives</span>
                </div>
              </div>
              <ArrowRight size={16} />
            </button>
          )}
        </div>

        {/* Cancel Button */}
        <button
          onClick={() => setShowPaymentModal(false)}
          className="w-full mt-4 text-center text-sm font-semibold text-muted hover:text-body transition-colors py-2"
          style={{ cursor: "pointer", background: "none", border: "none" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  /* DELIVERY ADDRESS — the "Deliver to" card (rendered inline in each layout)
     opens these. Picking an address makes it the default, which the database
     mirrors into profiles.address (what checkout reads). */
  const addressModals = (
    <>
      <AddressPicker open={addressPickerOpen} onClose={() => setAddressPickerOpen(false)} />
      <AddressFormModal
        open={addressFormOpen}
        onClose={() => setAddressFormOpen(false)}
        isFirst={!addressFromProfile(user?.address)}
        preselectDefault
      />
    </>
  );

  /* UI */

  /* ============================================================
     MOBILE LAYOUT (≤640px) — shares all cart state/handlers.
  ============================================================ */
  if (isMobile) {
    const processingOverlay = isProcessing && (
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 backdrop-blur-2xl bg-overlay">
        <div className="bg-surface/10 backdrop-blur-md border border-inverse/20 rounded-[2rem] p-10 max-w-sm w-full text-center shadow-2xl">
          <div className="relative mb-8 h-20 flex items-center justify-center">
            <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full animate-pulse"></div>
            <Package size={56} className="text-inverse relative animate-bounce" />
          </div>
          <h2
            className="text-xl font-bold text-inverse leading-tight"
            style={{ fontFamily: "Inter, sans-serif" }}
          >
            Placing your order…
            <br />
            Please wait for confirmation
          </h2>
          <div className="flex justify-center gap-1.5 pt-5">
            <div className="w-1.5 h-1.5 rounded-full bg-surface opacity-20 animate-bounce [animation-delay:-0.3s]"></div>
            <div className="w-1.5 h-1.5 rounded-full bg-surface opacity-40 animate-bounce [animation-delay:-0.15s]"></div>
            <div className="w-1.5 h-1.5 rounded-full bg-surface opacity-60 animate-bounce"></div>
          </div>
        </div>
      </div>
    );

    return (
      <div
        className="min-h-screen w-full"
        style={{
          background: "var(--color-background)",
          fontFamily: "Inter, sans-serif",
          overflowX: "hidden",
          maxWidth: "100vw",
        }}
      >
        {/* Phase 8.2: guest upgrade banner */}
        {user?.is_anonymous && (
          <div
            className="flex items-center justify-between gap-4"
            style={{ background: "color-mix(in srgb, var(--color-primary) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)", borderRadius: "12px", padding: "12px 16px", margin: "16px 20px 0" }}
          >
            <div className="flex flex-col" style={{ gap: "2px", minWidth: 0 }}>
              <span style={{ fontWeight: 700, fontSize: "13px", color: "var(--color-primary)" }}>Shopping as Guest</span>
              <span style={{ fontSize: "12px", color: "var(--color-body)" }}>Create an account to save your order history.</span>
            </div>
            <a href="/signup" style={{ flexShrink: 0, fontWeight: 700, fontSize: "12px", color: "var(--color-primary)", border: "1.5px solid var(--color-primary)", borderRadius: "9999px", padding: "6px 14px", textDecoration: "none" }}>Sign up</a>
          </div>
        )}
        {cartItems.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center text-center"
            style={{ minHeight: "100vh", gap: "16px", padding: "96px 24px 0" }}
          >
            <ShoppingBag size={44} color="var(--color-border-strong)" />
            <p style={{ color: "var(--color-muted)", fontSize: "14px", fontWeight: 600 }}>
              Your cart is empty.
            </p>
            <button
              onClick={() => navigate("/products")}
              style={{
                background: "var(--color-primary)",
                color: "var(--color-inverse)",
                fontWeight: 700,
                fontSize: "14px",
                padding: "12px 24px",
                borderRadius: "9999px",
              }}
            >
              Discover Products
            </button>
          </div>
        ) : (
          <>
            <main style={{ padding: "96px 20px 100px" }}>
              <div style={{ marginBottom: "12px" }}>
                <DeliverToCard compact onChange={() => setAddressPickerOpen(true)} onAdd={() => setAddressFormOpen(true)} />
              </div>
              <div className="flex flex-col" style={{ gap: "12px" }}>
                {cartItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex bg-surface"
                    style={{
                      borderRadius: "12px",
                      padding: "12px",
                      gap: "12px",
                      boxShadow: "0px 4px 20px rgba(26,43,60,0.05)",
                    }}
                  >
                    <div
                      className="flex-shrink-0 flex items-center justify-center"
                      style={{
                        width: "80px",
                        height: "80px",
                        background: "var(--color-surface-muted)",
                        borderRadius: "8px",
                        padding: "8px",
                      }}
                    >
                      <img
                        src={item.thumbnail || item.image}
                        alt={item.title}
                        className="w-full h-full"
                        style={{ objectFit: "cover", borderRadius: "4px" }}
                      />
                    </div>
                    <div
                      className="flex flex-col flex-1"
                      style={{ minWidth: 0 }}
                    >
                      <p
                        style={{
                          color: "var(--color-muted)",
                          fontWeight: 600,
                          fontSize: "11px",
                          textTransform: "uppercase",
                          letterSpacing: "0.6px",
                        }}
                      >
                        {item.category}
                      </p>
                      <h3
                        style={{
                          color: "var(--color-ink)",
                          fontWeight: 700,
                          fontSize: "14px",
                          lineHeight: "18px",
                          marginTop: "2px",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {item.title}
                        {item.variant_name ? <span style={{ fontWeight: 500, color: "var(--color-body)" }}> · {item.variant_name}</span> : null}
                        {item.unavailable ? <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: "var(--color-error)" }}>NO LONGER AVAILABLE</span> : null}
                      </h3>
                      <div
                        className="flex items-center justify-between"
                        style={{ marginTop: "auto", paddingTop: "8px" }}
                      >
                        <div
                          className="flex items-center"
                          style={{
                            border: "1px solid var(--color-border)",
                            borderRadius: "9999px",
                            overflow: "hidden",
                          }}
                        >
                          <button
                            onClick={() => handleRemoveCart(item.id)}
                            aria-label="Decrease"
                            className="flex items-center justify-center"
                            style={{
                              width: "30px",
                              height: "30px",
                              color: "var(--color-primary)",
                            }}
                          >
                            <Minus size={14} />
                          </button>
                          <span
                            style={{
                              minWidth: "24px",
                              textAlign: "center",
                              fontWeight: 700,
                              fontSize: "13px",
                              color: "var(--color-ink)",
                            }}
                          >
                            {item.quantity}
                          </span>
                          <button
                            onClick={() => handleAddCart(item)}
                            aria-label="Increase"
                            className="flex items-center justify-center"
                            style={{
                              width: "30px",
                              height: "30px",
                              color: "var(--color-primary)",
                            }}
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                        {(() => {
                          const price = Number(item.price);
                          const qty = Number(item.quantity);
                          const discount = isDiscountActive(item) ? Number(item.discount || 0) : 0;

                          const originalTotal = price * qty;
                          const discountedTotal =
                            originalTotal - (originalTotal * discount) / 100;

                          return discount > 0 ? (
                            <div className="flex flex-col items-end">
                              <span
                                style={{
                                  color: "var(--color-primary)",
                                  fontWeight: 700,
                                  fontSize: "16px",
                                }}
                              >
                                ₹{discountedTotal.toFixed(2)}
                              </span>

                              <span
                                style={{
                                  textDecoration: "line-through",
                                  color: "var(--color-muted)",
                                  fontSize: "12px",
                                }}
                              >
                                ₹{originalTotal.toFixed(2)}
                              </span>

                              <span
                                style={{
                                  color: "var(--color-success)",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                }}
                              >
                                {discount}% OFF
                              </span>
                            </div>
                          ) : (
                            <span
                              style={{
                                color: "var(--color-ink)",
                                fontWeight: 700,
                                fontSize: "16px",
                              }}
                            >
                              ₹{originalTotal.toFixed(2)}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                    <button
                      onClick={() => handleSaveForLater(item)}
                      disabled={savingId === String(item.id || item.compound_id)}
                      style={{ marginTop: "4px", fontSize: "12px", fontWeight: 600, color: "var(--color-primary)", background: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px", opacity: savingId === String(item.id || item.compound_id) ? 0.5 : 1 }}
                    >
                      <Bookmark size={12} /> {savingId === String(item.id || item.compound_id) ? "Saving…" : "Save for later"}
                    </button>
                  </div>
                ))}
              </div>

              <button
                onClick={handleClearCart}
                className="w-full flex items-center justify-center"
                style={{
                  marginTop: "16px",
                  height: "44px",
                  borderRadius: "9999px",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-muted)",
                  fontWeight: 600,
                  fontSize: "13px",
                  background: "transparent",
                }}
              >
                Clear Cart
              </button>

              {/* Price-change banner (Phase 5.9) */}
              {hasAnyPriceChange && (
                <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "10px", background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.3)", borderRadius: "10px", padding: "10px 12px" }}>
                  <AlertTriangle size={16} style={{ color: "#ca8a04", flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <p style={{ fontWeight: 600, fontSize: "13px", color: "var(--color-ink)" }}>
                      {Object.keys(priceChanges).length === 1 ? "1 item price has changed" : `${Object.keys(priceChanges).length} items have new prices`}
                    </p>
                    <p style={{ fontSize: "11px", color: "var(--color-muted)" }}>Totals reflect the latest prices.</p>
                  </div>
                  <button onClick={handleAcknowledgePriceChanges} style={{ background: "#ca8a04", color: "#fff", fontWeight: 700, fontSize: "12px", padding: "6px 10px", borderRadius: "6px", cursor: "pointer" }}>Got it</button>
                </div>
              )}

              {/* Available coupons (Phase 5.5) */}
              {couponsLoaded && coupons.length > 0 && (
                <div style={{ marginTop: "14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", color: "var(--color-muted)" }}>Available Coupons</span>
                    <button onClick={() => setShowCoupons(v => !v)} style={{ fontSize: "12px", color: "var(--color-primary)", background: "none", cursor: "pointer", fontWeight: 600 }}>{showCoupons ? "Hide" : "Show"}</button>
                  </div>
                  {showCoupons && coupons.map((coupon) => (
                    <div key={coupon.code} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", background: "var(--color-surface-muted)", borderRadius: "8px", padding: "8px 10px", marginBottom: "6px" }}>
                      <div><p style={{ fontWeight: 700, fontSize: "13px", color: "var(--color-primary)" }}>{coupon.code}</p><p style={{ fontSize: "11px", color: "var(--color-muted)" }}>{describeCoupon(coupon)}</p></div>
                      {appliedPromo?.code === coupon.code ? (
                        <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-success)" }}>✓ Applied</span>
                      ) : (
                        <button onClick={() => handleApplyCouponFromList(coupon)} style={{ background: "var(--color-primary)", color: "var(--color-inverse)", fontWeight: 700, fontSize: "12px", padding: "5px 10px", borderRadius: "6px", cursor: "pointer" }}>Apply</button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Saved for later (Phase 5.2) */}
              {savedItems.length > 0 && (
                <div style={{ marginTop: "16px" }}>
                  <p style={{ fontWeight: 700, fontSize: "14px", color: "var(--color-ink)", marginBottom: "8px" }}>Saved for later ({savedItems.length})</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {savedItems.map((item) => {
                      const key = String(item.compound_id || item.id);
                      const busy = movingId === key || removingId === key;
                      return (
                        <div key={key} style={{ display: "flex", gap: "10px", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "10px", opacity: busy ? 0.55 : 1 }}>
                          <div style={{ width: "56px", height: "56px", borderRadius: "6px", background: "var(--color-surface-muted)", overflow: "hidden", flexShrink: 0 }}>
                            {item.image && <img src={item.image} alt={item.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontWeight: 600, fontSize: "13px", color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</p>
                            <p style={{ fontWeight: 700, fontSize: "13px", color: "var(--color-primary)" }}>₹{Number(item.price || 0).toFixed(2)}</p>
                            <div style={{ display: "flex", gap: "12px", marginTop: "4px" }}>
                              <button onClick={() => handleMoveSavedToCart(item)} disabled={busy} style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-primary)", background: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}><CartIcon size={12} /> Move to cart</button>
                              <button onClick={() => handleRemoveSaved(item)} disabled={busy} style={{ fontSize: "12px", fontWeight: 600, color: "#ef4444", background: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}><Trash2 size={12} /> Remove</button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Gift wrap (Phase 5.11) — only shown when admin enables gift wrap */}
              {giftWrapConfig.giftWrapEnabled && (
              <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "14px 16px", marginTop: "14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <p style={{ fontWeight: 600, fontSize: "14px", color: "var(--color-ink)" }}> Gift wrap this order</p>
                    <p style={{ fontSize: "11px", color: "var(--color-muted)", marginTop: "2px" }}>{giftWrapConfig.giftWrapFree ? " Gift wrapping is free!" : ` Add gift wrapping for ₹${giftWrapConfig.giftWrapCost}`}</p>
                  </div>
                  <button
                    onClick={() => setGiftWrap(v => !v)}
                    role="switch"
                    aria-checked={giftWrap}
                    style={{ width: "44px", height: "24px", borderRadius: "12px", background: giftWrap ? "var(--color-primary)" : "var(--color-surface-muted)", position: "relative", cursor: "pointer", flexShrink: 0, transition: "background 0.2s" }}
                  >
                    <span style={{ position: "absolute", top: "2px", left: giftWrap ? "20px" : "2px", width: "20px", height: "20px", borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                  </button>
                </div>
                {giftWrap && (
                  <div style={{ marginTop: "10px" }}>
                    <textarea
                      value={giftMessage}
                      onChange={(e) => setGiftMessage(e.target.value.slice(0, 200))}
                      placeholder="Add a personal message (optional)"
                      rows={3}
                      style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-surface-muted)", color: "var(--color-ink)", fontSize: "13px", resize: "none", fontFamily: "inherit" }}
                    />
                    <p style={{ textAlign: "right", fontSize: "11px", color: "var(--color-muted)", marginTop: "4px" }}>{giftMessage.length}/200</p>
                  </div>
                )}
              </div>

              )}

              {/* Cross-sell shelf (Phase 5.7) */}
              {suggestionList.length > 0 && (
                <div style={{ marginTop: "20px" }}>
                  <p style={{ fontWeight: 700, fontSize: "14px", color: "var(--color-ink)", marginBottom: "10px" }}>You may also like</p>
                  <div style={{ display: "flex", gap: "12px", overflowX: "auto", paddingBottom: "6px" }}>
                    {suggestionList.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => navigate(`/product/${p.id}`)}
                        style={{ flexShrink: 0, width: "120px", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "10px", overflow: "hidden", textAlign: "left" }}
                      >
                        <div style={{ width: "100%", height: "90px", background: "var(--color-surface-muted)", overflow: "hidden" }}>
                          {(p.thumbnail || p.image) && <img src={p.thumbnail || p.image} alt={p.title || p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                        </div>
                        <div style={{ padding: "8px" }}>
                          <p style={{ fontWeight: 600, fontSize: "12px", color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || p.name}</p>
                          <p style={{ fontWeight: 700, fontSize: "12px", color: "var(--color-primary)", marginTop: "2px" }}>{money(p.price)}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Task 1.17 — delivery/returns terms reachable from checkout. */}
              <PolicyLinks style={{ marginTop: "16px" }} />
            </main>

            {/* BOTTOM ACTION BAR — sits above the global mobile tab bar */}
            <div
              className="fixed inset-x-0 z-50 flex items-center justify-between"
              style={{
                bottom: "calc(56px + env(safe-area-inset-bottom))",
                height: "81px",
                padding: "16px 20px",
                gap: "16px",
                background: "color-mix(in srgb, var(--color-surface) 92%, transparent)",
                backdropFilter: "blur(6px)",
                WebkitBackdropFilter: "blur(6px)",
                borderTop: "1px solid color-mix(in srgb, var(--color-border) 30%, transparent)",
              }}
            >
              <div className="flex flex-col">
                <span
                  style={{
                    fontSize: "11px",
                    color: "var(--color-muted)",
                    fontWeight: 500,
                  }}
                >
                  Total ({totalItems})
                </span>
                <span
                  style={{
                    fontSize: "20px",
                    fontWeight: 800,
                    color: "var(--color-primary)",
                    letterSpacing: "-0.4px",
                  }}
                >
                  {/* Was `${Number(total).toFixed(2)}` — wrong on both counts.
                      `total` is the raw MRP sum, so it ignored per-item
                      discounts, the shipping estimate and any applied promo,
                      meaning this bar could disagree with the Order Summary
                      directly above it AND with the amount actually charged.
                      `orderTotal` is the figure the payment functions receive. */}
                  {money(orderTotal)}
                </span>
              </div>
              {isCheckoutDisabled ? (
                <div className="text-center p-2.5 border border-error-border bg-error-subtle rounded-2xl text-[10px] font-bold text-error flex-1 max-w-[210px] leading-tight">
                  No payment methods available.<br />Please contact administrator.
                </div>
              ) : (
                <button
                  onClick={handleCheckoutClick}
                  disabled={isProcessing}
                  className="flex items-center justify-center flex-1"
                  style={{
                    maxWidth: "210px",
                    height: "48px",
                    background: "var(--color-primary)",
                    borderRadius: "9999px",
                    color: "var(--color-inverse)",
                    fontWeight: 700,
                    fontSize: "16px",
                    boxShadow:
                      "0px 10px 15px -3px color-mix(in srgb, var(--color-primary) 20%, transparent), 0px 4px 6px -4px color-mix(in srgb, var(--color-primary) 20%, transparent)",
                    opacity: isProcessing ? 0.6 : 1,
                  }}
                >
                  {isProcessing ? "Processing…" : "Place Order"}
                </button>
              )}
            </div>
          </>
        )}

        {processingOverlay}
        {paymentModal}
        {addressModals}
      </div>
    );
  }


  /* ============================================================
     DESKTOP LAYOUT (lg+) — SG Ecommerce artisanal redesign
  ============================================================ */
  return (
    <>
      {paymentModal}
      {addressModals}

      {/* Processing overlay */}
      {isProcessing && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center p-6"
          style={{ background: "var(--color-overlay)", backdropFilter: "blur(8px)" }}
        >
          <div
            className="text-center"
            style={{ background: "var(--color-surface)", borderRadius: "24px", padding: "48px", maxWidth: "360px" }}
          >
            <div className="flex items-center justify-center" style={{ marginBottom: "20px" }}>
              <Package size={56} style={{ color: "var(--color-primary)" }} className="animate-bounce" />
            </div>
            <h2 style={{ fontWeight: 800, fontSize: "20px", color: "var(--color-ink)" }}>
              Placing your order…
            </h2>
            <p style={{ fontSize: "14px", color: "var(--color-body)", marginTop: "8px" }}>
              Please wait for confirmation
            </p>
          </div>
        </div>
      )}

      <div
        style={{
          fontFamily: "'Plus Jakarta Sans', Inter, sans-serif",
          background: "#EDE8E1",
          minHeight: "100vh",
          padding: "88px 24px 48px",
        }}
      >
        <div style={{ maxWidth: "1240px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "32px" }}>

          {/* ── HEADER ── */}
          <header>
            <p style={{ fontSize: "12px", fontWeight: 600, color: "#7A8481", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {totalItems} item{totalItems !== 1 ? "s" : ""} in your cart
            </p>
            <h1 style={{ fontSize: "36px", fontWeight: 800, color: "#1E2524", letterSpacing: "-0.75px", marginTop: "4px" }}>
              Your Cart
            </h1>
          </header>

          {/* ── GUEST BANNER ── */}
          {user?.is_anonymous && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", background: "rgba(6,78,59,0.08)", border: "1px solid rgba(6,78,59,0.2)", borderRadius: "14px", padding: "14px 24px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontWeight: 700, fontSize: "14px", color: "#064E3B" }}>You're shopping as a guest</span>
                <span style={{ fontSize: "13px", color: "#57534E" }}>Create an account to save your order history, wishlist, and address book.</span>
              </div>
              <a href="/signup" style={{ flexShrink: 0, fontWeight: 700, fontSize: "13px", color: "#fff", background: "#064E3B", borderRadius: "9999px", padding: "10px 24px", textDecoration: "none", whiteSpace: "nowrap" }}>Create Account</a>
            </div>
          )}

          {/* ── EMPTY STATE ── */}
          {cartItems.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: "20px", padding: "80px 0" }}>
              <div style={{ width: "96px", height: "96px", borderRadius: "9999px", background: "rgba(255,255,255,0.7)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
                <ShoppingBag size={40} style={{ color: "#064E3B" }} />
              </div>
              <h2 style={{ fontWeight: 800, fontSize: "24px", color: "#1C1917" }}>Your cart is empty</h2>
              <p style={{ fontSize: "15px", color: "#78716C" }}>Looks like you haven't added anything yet.</p>
              <button
                onClick={() => navigate("/products")}
                style={{ background: "#064E3B", color: "#fff", fontWeight: 700, fontSize: "15px", padding: "14px 36px", borderRadius: "12px", cursor: "pointer", border: "none" }}
              >
                Continue Shopping
              </button>
            </div>
          ) : (
            /* ── MAIN TWO-COLUMN GRID ── */
            <main style={{ display: "grid", gridTemplateColumns: "7fr 5fr", gap: "32px", alignItems: "start" }}>

              {/* ═══ LEFT COLUMN ═══ */}
              <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

                {/* Price-change banner */}
                {hasAnyPriceChange && (
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", background: "rgba(234,179,8,0.12)", border: "1px solid rgba(234,179,8,0.35)", borderRadius: "12px", padding: "12px 16px" }}>
                    <AlertTriangle size={16} style={{ color: "#ca8a04", flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <p style={{ fontWeight: 600, fontSize: "13px", color: "#1C1917" }}>
                        {Object.keys(priceChanges).length === 1 ? "1 item price has changed" : `${Object.keys(priceChanges).length} items have new prices`}
                      </p>
                      <p style={{ fontSize: "11px", color: "#78716C" }}>Totals reflect the latest prices.</p>
                    </div>
                    <button onClick={handleAcknowledgePriceChanges} style={{ background: "#ca8a04", color: "#fff", fontWeight: 700, fontSize: "12px", padding: "6px 12px", borderRadius: "8px", cursor: "pointer", border: "none" }}>Got it</button>
                  </div>
                )}

                {/* Items header row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#A8A29E" }}>Active Selection</span>
                  <button
                    onClick={handleClearCart}
                    style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 600, color: "#78716C", background: "none", border: "none", cursor: "pointer" }}
                  >
                    <Trash2 size={13} /> Clear Cart
                  </button>
                </div>

                {/* ── CART ITEMS LIST ── */}
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                  {cartItems.map((item) => {
                    const mrp = Number(item.price || 0);
                    const disc = isDiscountActive(item) ? Number(item.discount || 0) : 0;
                    const linePrice = mrp - (mrp * disc) / 100;
                    const key = String(item.compound_id || item.id);
                    return (
                      <article
                        key={key}
                        style={{
                          background: "#FFFFFF",
                          borderRadius: "16px",
                          padding: "16px 20px",
                          boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "16px",
                          border: item.unavailable ? "1px solid #FCA5A5" : "1px solid transparent",
                        }}
                      >
                        {/* Left: thumbnail + details */}
                        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                          {/* Thumbnail */}
                          <div style={{ position: "relative", width: "80px", height: "80px", borderRadius: "12px", overflow: "hidden", background: "#F5F5F4", flexShrink: 0 }}>
                            <img
                              src={item.thumbnail || item.image}
                              alt={item.title}
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                            {item.category && (
                              <span style={{ position: "absolute", top: "5px", left: "5px", background: "rgba(0,0,0,0.65)", color: "#fff", fontSize: "8px", fontWeight: 800, padding: "2px 5px", borderRadius: "3px", letterSpacing: "0.5px", textTransform: "uppercase" }}>
                                {item.category?.slice(0, 7)}
                              </span>
                            )}
                          </div>
                          {/* Details */}
                          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span style={{ fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.6px", background: "#ECFDF5", color: "#065F46", padding: "2px 7px", borderRadius: "4px", display: "inline-block", width: "fit-content" }}>
                              {item.category}
                            </span>
                            <h2 style={{ fontSize: "14px", fontWeight: 700, color: "#1C1917", lineHeight: 1.35, margin: 0 }}>
                              {item.title}
                              {item.variant_name ? <span style={{ fontWeight: 500, color: "#78716C" }}> · {item.variant_name}</span> : null}
                            </h2>
                            {item.unavailable && (
                              <span style={{ fontSize: "11px", fontWeight: 700, color: "#DC2626" }}> No longer available</span>
                            )}
                            {disc > 0 && (
                              <span style={{ fontSize: "11px", color: "#065F46", fontWeight: 600 }}>{disc}% OFF applied</span>
                            )}
                          </div>
                        </div>

                        {/* Right: price + stepper + actions */}
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "10px", flexShrink: 0 }}>
                          {/* Price */}
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: "16px", fontWeight: 800, color: "#1C1917" }}>{money(linePrice * item.quantity)}</div>
                            {item.quantity > 1 && (
                              <div style={{ fontSize: "10px", color: "#A8A29E" }}>{money(linePrice)} / unit</div>
                            )}
                            {disc > 0 && (
                              <div style={{ fontSize: "10px", color: "#A8A29E", textDecoration: "line-through" }}>{money(mrp * item.quantity)}</div>
                            )}
                          </div>
                          {/* Stepper + actions */}
                          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                            {/* Quantity stepper */}
                            <div style={{ display: "flex", alignItems: "center", background: "#F5F5F4", borderRadius: "8px", padding: "4px 10px", gap: "10px", border: "1px solid #E7E5E4" }}>
                              <button
                                onClick={() => handleRemoveCart(key)}
                                style={{ fontWeight: 800, color: "#1C1917", fontSize: "16px", background: "none", border: "none", cursor: "pointer", lineHeight: 1, padding: "0 2px" }}
                              >
                                −
                              </button>
                              <span style={{ fontWeight: 700, fontSize: "13px", minWidth: "14px", textAlign: "center", color: "#1C1917" }}>
                                {item.quantity}
                              </span>
                              <button
                                onClick={() => handleAddCart(item)}
                                style={{ fontWeight: 800, color: "#1C1917", fontSize: "16px", background: "none", border: "none", cursor: "pointer", lineHeight: 1, padding: "0 2px" }}
                              >
                                +
                              </button>
                            </div>
                            {/* Action links */}
                            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                              <button
                                onClick={() => handleSaveForLater(item)}
                                disabled={savingId === key}
                                style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", fontWeight: 600, color: "#78716C", background: "none", border: "none", cursor: "pointer", opacity: savingId === key ? 0.5 : 1 }}
                              >
                                <Bookmark size={13} />
                                {savingId === key ? "Saving…" : "Save"}
                              </button>
                              <button
                                onClick={() => handleDeleteItem(key)}
                                style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", fontWeight: 600, color: "#BE123C", background: "none", border: "none", cursor: "pointer" }}
                              >
                                <Trash2 size={13} /> Remove
                              </button>
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>

                {/* ── SAVED FOR LATER ── */}
                {savedItems.length > 0 && (
                  <section style={{ marginTop: "8px", background: "rgba(255,255,255,0.55)", backdropFilter: "blur(8px)", borderRadius: "16px", padding: "24px", border: "1px solid rgba(255,255,255,0.4)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "#1C1917", margin: 0 }}>Saved for later</h3>
                        <span style={{ fontSize: "11px", fontWeight: 600, background: "#E7E5E4", color: "#57534E", padding: "2px 8px", borderRadius: "9999px" }}>{savedItems.length} items</span>
                      </div>
                      <span style={{ fontSize: "11px", fontStyle: "italic", color: "#A8A29E" }}>Ready when you are</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                      {savedItems.map((item) => {
                        const key = String(item.compound_id || item.id);
                        const busy = movingId === key || removingId === key;
                        return (
                          <div
                            key={key}
                            style={{ background: "#FFFFFF", borderRadius: "12px", padding: "14px", boxShadow: "0 1px 3px rgba(0,0,0,0.06)", opacity: busy ? 0.55 : 1, border: "1px solid #F5F5F4" }}
                          >
                            <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                              <div style={{ width: "56px", height: "56px", borderRadius: "8px", overflow: "hidden", background: "#F5F5F4", flexShrink: 0 }}>
                                {item.image && <img src={item.image} alt={item.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <span style={{ fontSize: "9px", fontWeight: 700, color: "#A8A29E", textTransform: "uppercase", letterSpacing: "0.6px" }}>{item.category}</span>
                                <p style={{ fontSize: "12px", fontWeight: 700, color: "#1C1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: "2px 0" }}>{item.title}</p>
                                <p style={{ fontSize: "12px", fontWeight: 700, color: "#1C1917", margin: 0 }}>{money(item.price)}</p>
                              </div>
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", paddingTop: "10px", borderTop: "1px solid #F5F5F4", fontSize: "11px" }}>
                              <button
                                onClick={() => handleMoveSavedToCart(item)}
                                disabled={busy}
                                style={{ fontWeight: 700, color: "#1C1917", display: "flex", alignItems: "center", gap: "4px", background: "none", border: "none", cursor: "pointer" }}
                              >
                                Move to cart
                              </button>
                              <button
                                onClick={() => handleRemoveSaved(item)}
                                disabled={busy}
                                style={{ color: "#A8A29E", fontWeight: 600, background: "none", border: "none", cursor: "pointer" }}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
              </section>

              {/* ═══ RIGHT COLUMN ═══ */}
              <aside style={{ display: "flex", flexDirection: "column", gap: "16px", position: "sticky", top: "96px" }}>

                {/* Deliver To */}
                <DeliverToCard onChange={() => setAddressPickerOpen(true)} onAdd={() => setAddressFormOpen(true)} />

                {/* ── ORDER SUMMARY CARD ── */}
                <div style={{ background: "#FFFFFF", borderRadius: "16px", padding: "24px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", gap: "20px" }}>
                  {/* Title */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h2 style={{ fontSize: "18px", fontWeight: 800, color: "#1C1917", margin: 0 }}>Order Summary</h2>
                    <span style={{ background: "#F5F5F4", color: "#44403C", fontSize: "12px", padding: "3px 10px", borderRadius: "9999px", fontWeight: 600 }}>{totalItems} items</span>
                  </div>

                  {/* Breakdown */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px", borderBottom: "1px solid #F5F5F4", paddingBottom: "16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", color: "#57534E" }}>
                      <span>Cart Subtotal</span>
                      <span style={{ fontWeight: 700, color: "#1C1917" }}>{money(subtotalRounded)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", color: "#57534E" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span>Shipping</span>
                        <span style={{ fontSize: "10px", fontFamily: "monospace", background: "#F5F5F4", color: "#78716C", padding: "1px 6px", borderRadius: "4px", fontWeight: 700 }}>
                          {shippingEstimate === 0 ? "FREE" : "STANDARD"}
                        </span>
                      </div>
                      <span style={{ fontWeight: 700, color: shippingEstimate === 0 ? "#065F46" : "#1C1917" }}>
                        {shippingEstimate === 0 ? "Free" : money(shippingEstimate)}
                      </span>
                    </div>
                    {promoDiscount > 0 && (
                      <div style={{ display: "flex", justifyContent: "space-between", color: "#065F46" }}>
                        <span>Promo ({appliedPromo?.code})</span>
                        <span style={{ fontWeight: 700 }}>−{money(promoDiscount)}</span>
                      </div>
                    )}
                    {giftWrapConfig.giftWrapEnabled && giftWrap && (
                      <div style={{ display: "flex", justifyContent: "space-between", color: "#57534E" }}>
                        <span> Gift Wrap</span>
                        <span style={{ fontWeight: 700, color: giftWrapConfig.giftWrapFree ? "#065F46" : "#1C1917" }}>
                          {giftWrapConfig.giftWrapFree ? "Free" : money(giftWrapCharge)}
                        </span>
                      </div>
                    )}
                    <div style={{ display: "flex", justifyContent: "space-between", color: "#57534E" }}>
                      <span>Taxes</span>
                      <span style={{ fontSize: "11px", color: "#78716C" }}>Included (GST)</span>
                    </div>
                  </div>

                  {/* Voucher input */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <input
                        value={promoCode}
                        onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                        placeholder="ENTER VOUCHER CODE"
                        style={{ flex: 1, background: "#FAFAF9", border: "1px solid #D6D3D1", borderRadius: "10px", padding: "9px 12px", fontSize: "11px", fontFamily: "monospace", letterSpacing: "0.08em", outline: "none", color: "#1C1917" }}
                      />
                      <button
                        onClick={handleApplyPromo}
                        style={{ background: "#1C1917", color: "#fff", fontSize: "12px", fontWeight: 700, padding: "9px 18px", borderRadius: "10px", border: "none", cursor: "pointer", whiteSpace: "nowrap" }}
                      >
                        Apply
                      </button>
                    </div>
                    {couponsLoaded && coupons.length > 0 && (
                      <button
                        onClick={() => setShowCoupons((v) => !v)}
                        style={{ fontSize: "12px", color: "#065F46", fontWeight: 700, background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
                      >
                        {showCoupons ? "Hide" : `Available coupons (${coupons.length})`}
                      </button>
                    )}
                    {showCoupons && coupons.map((c) => (
                      <div key={c.code} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F5F5F4", borderRadius: "8px", padding: "8px 12px" }}>
                        <div>
                          <p style={{ fontWeight: 700, fontSize: "13px", color: "#065F46", margin: 0 }}>{c.code}</p>
                          <p style={{ fontSize: "11px", color: "#78716C", margin: 0 }}>{describeCoupon(c)}</p>
                        </div>
                        {appliedPromo?.code === c.code ? (
                          <span style={{ fontSize: "11px", fontWeight: 700, color: "#059669" }}>✓ Applied</span>
                        ) : (
                          <button onClick={() => handleApplyCouponFromList(c)} style={{ background: "#064E3B", color: "#fff", fontSize: "11px", fontWeight: 700, padding: "4px 10px", borderRadius: "6px", border: "none", cursor: "pointer" }}>Apply</button>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Gift wrap toggle */}
                  {giftWrapConfig.giftWrapEnabled && (
                    <>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: "4px", borderTop: "1px solid #F5F5F4" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <Package size={16} style={{ color: "#78716C" }} />
                          <div>
                            <p style={{ fontSize: "12px", fontWeight: 700, color: "#1C1917", margin: 0 }}>Complimentary gift wrap</p>
                            <p style={{ fontSize: "11px", color: "#78716C", margin: 0 }}>{giftWrapConfig.giftWrapFree ? "Free gift wrapping" : `Add for ${money(giftWrapConfig.giftWrapCost)}`}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => setGiftWrap((v) => !v)}
                          role="switch"
                          aria-checked={giftWrap}
                          style={{ width: "38px", height: "22px", borderRadius: "11px", background: giftWrap ? "#065F46" : "#D1D5DB", position: "relative", cursor: "pointer", flexShrink: 0, border: "none", transition: "background 0.2s" }}
                        >
                          <span style={{ position: "absolute", top: "3px", left: giftWrap ? "18px" : "3px", width: "16px", height: "16px", borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                        </button>
                      </div>
                      {giftWrap && (
                        <textarea
                          value={giftMessage}
                          onChange={(e) => setGiftMessage(e.target.value.slice(0, 200))}
                          placeholder="Add a personal message (optional)"
                          rows={3}
                          style={{ width: "100%", padding: "9px 12px", borderRadius: "8px", border: "1px solid #E7E5E4", background: "#FAFAF9", fontSize: "13px", resize: "none", fontFamily: "inherit", color: "#1C1917", outline: "none", boxSizing: "border-box" }}
                        />
                      )}
                    </>
                  )}

                  {/* Total Due box */}
                  <div style={{ background: "rgba(245,245,244,0.8)", borderRadius: "12px", padding: "16px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#78716C" }}>TOTAL DUE</span>
                      <span style={{ display: "block", fontSize: "11px", color: "#A8A29E", marginTop: "2px" }}>Incl. shipping & taxes</span>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "28px", fontWeight: 800, color: "#1C1917", letterSpacing: "-0.5px" }}>{money(orderTotal)}</div>
                      {shippingEstimate === 0 && subtotal > 0 && (
                        <div style={{ fontSize: "10px", fontFamily: "monospace", fontWeight: 700, color: "#065F46" }}>Free shipping applied ✓</div>
                      )}
                    </div>
                  </div>

                  {/* Checkout button */}
                  {isCheckoutDisabled ? (
                    <div style={{ textAlign: "center", padding: "14px", border: "1px solid #FCA5A5", background: "#FEF2F2", borderRadius: "12px", fontSize: "12px", fontWeight: 700, color: "#DC2626", lineHeight: 1.5 }}>
                      No payment methods available.<br />Please contact administrator.
                    </div>
                  ) : (
                    <button
                      onClick={handleCheckoutClick}
                      disabled={isCheckoutDisabled || cartItems.length === 0 || isProcessing}
                      style={{
                        width: "100%",
                        background: "#064E3B",
                        color: "#fff",
                        height: "46px",
                        borderRadius: "12px",
                        fontSize: "12px",
                        fontWeight: 700,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "8px",
                        cursor: (isCheckoutDisabled || isProcessing) ? "not-allowed" : "pointer",
                        opacity: (isCheckoutDisabled || isProcessing) ? 0.5 : 1,
                        border: "none",
                        boxShadow: "0 4px 14px rgba(6,78,59,0.25)",
                      }}
                    >
                      {isProcessing ? "Processing…" : "Proceed to Checkout →"}
                    </button>
                  )}

                  {/* SSL note */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", fontSize: "11px", color: "#78716C" }}>
                    <Lock size={13} /> Secure SSL Encrypted Checkout
                  </div>
                </div>

                {/* Policy Links */}
                <PolicyLinks />

                {/* Support card */}
                <div style={{ background: "rgba(231,229,228,0.5)", borderRadius: "16px", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #E7E5E4" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div style={{ width: "34px", height: "34px", borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 4px rgba(0,0,0,0.08)", flexShrink: 0 }}>
                      <Headphones size={16} style={{ color: "#44403C" }} />
                    </div>
                    <div>
                      <p style={{ fontSize: "12px", fontWeight: 700, color: "#1C1917", margin: 0 }}>Need help with your order?</p>
                      <p style={{ fontSize: "11px", color: "#78716C", margin: 0 }}>Our team is available 9am – 7pm</p>
                    </div>
                  </div>
                  <button
                    onClick={() => window.open(`https://wa.me/919940574522?text=${encodeURIComponent("Hi, I need help with my order.")}`, "_blank", "noopener,noreferrer")}
                    style={{ fontSize: "12px", fontWeight: 700, color: "#064E3B", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}
                  >
                    Chat <ExternalLink size={11} />
                  </button>
                </div>
              </aside>
            </main>
          )}

          {/* ── RECOMMENDATIONS SHELF ── */}
          {suggestionList.length > 0 && (
            <section style={{ background: "#FFFFFF", borderRadius: "24px", padding: "32px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", border: "1px solid rgba(231,229,228,0.6)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px" }}>
                <div>
                  <span style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", color: "#A8A29E", letterSpacing: "0.1em" }}>RECOMMENDATIONS</span>
                  <h2 style={{ fontSize: "20px", fontWeight: 800, color: "#1C1917", margin: "4px 0 2px" }}>Frequently Bought Together</h2>
                  <p style={{ fontSize: "12px", color: "#78716C", margin: 0 }}>Complement your order with popular picks.</p>
                </div>
              </div>
              {loadingSuggestions ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "20px" }}>
                  {[...Array(4)].map((_, i) => (
                    <div key={i} style={{ background: "#F5F5F4", borderRadius: "16px", height: "260px", animation: "pulse 1.5s infinite" }} />
                  ))}
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "20px" }}>
                  {suggestionList.map((p) => {
                    const mrp = Number(p.price || 0);
                    const disc = Number(p.discount || 0);
                    const price = mrp - (mrp * disc) / 100;
                    return (
                      <article key={p.id} style={{ background: "#FBFBFA", borderRadius: "16px", padding: "12px", display: "flex", flexDirection: "column", justifyContent: "space-between", border: "1px solid #F5F5F4" }}>
                        <div>
                          <div style={{ position: "relative", width: "100%", height: "176px", borderRadius: "12px", overflow: "hidden", background: "#FFFFFF", marginBottom: "12px" }}>
                            {(p.thumbnail || p.image) && (
                              <img src={p.thumbnail || p.image} alt={p.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            )}
                            {disc > 0 && (
                              <span style={{ position: "absolute", top: "8px", left: "8px", fontSize: "9px", fontWeight: 700, color: "#1C1917", background: "rgba(255,255,255,0.85)", padding: "2px 8px", borderRadius: "9999px" }}>{disc}% OFF</span>
                            )}
                          </div>
                          <span style={{ fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.6px", color: "#A8A29E" }}>{p.category}</span>
                          <h3 style={{ fontSize: "12px", fontWeight: 700, color: "#1C1917", marginTop: "2px", marginBottom: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || p.name}</h3>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", paddingTop: "12px", borderTop: "1px solid rgba(231,229,228,0.6)" }}>
                          <span style={{ fontSize: "14px", fontWeight: 800, color: "#1C1917" }}>{money(price)}</span>
                          <button
                            onClick={() => navigate(`/product/${p.id}`)}
                            style={{ background: "#1C1917", color: "#fff", fontSize: "11px", fontWeight: 700, padding: "6px 14px", borderRadius: "8px", border: "none", cursor: "pointer" }}
                          >
                            View
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}

        </div>
      </div>
    </>
  );
};

export default CartPage;