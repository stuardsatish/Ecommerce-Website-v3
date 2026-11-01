import React, {
    useEffect,
    useState,
    useMemo,
    useCallback,
    memo,
    useRef,
} from "react";
import { useDispatch, useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { addProduct } from "../../context/ProductSlice";
import { addCart, removeCart } from "../../context/CartSlice";
import { addWishlist, removeWishlist } from "../../context/WishlistSlice";
import { ProductCard } from "../../features/products/ProductCard";
import { ProductCardSkeleton } from "../../features/products/ProductCardSkeleton";
import { NewProductCardSkeleton } from "../../features/products/NewProductCardSkeleton";
import { listPriceSummary, listStockSummary, needsOptionChoice } from "../../features/products/purchaseOptions";
import FiltersSidebar from "../../features/products/FiltersSidebar";
import useIsMobile from "../../hooks/useIsMobile";
import {
    ArrowLeft,
    Search as SearchIcon,
    ShoppingCart,
    Home as HomeIcon,
    Heart as HeartIcon,
    User as UserIcon,
    SlidersHorizontal,
    Star,
    Heart,
    X,
    Store,
    ChevronRight,
    RefreshCw,
    LayoutGrid,
    Filter,
} from "lucide-react";

import { supabase } from "../../context/SupabaseConfig";
import { mapProductRows } from "../../utils/supabaseProducts";
import { getRecentlyViewedIds } from "../../utils/recentlyViewed";
import { upsertCartItem, decrementOrRemoveCartItem, nextAddQuantity, nextRemoveQuantity } from "../../utils/supabaseCart";
import { addWishlistItem, removeWishlistItem } from "../../utils/supabaseWishlist";
import SearchSuggestions from "../../components/Common/SearchSuggestions";
import { searchProducts } from "../../services/productSearch";
import {
    addRecentSearch,
    clearRecentSearches,
    getRecentSearches,
    removeRecentSearch,
} from "../../utils/searchHistory";

/* ============================================================
   DESIGN TOKENS (matching Products.html Pelago palette)
============================================================ */
const TEAL = "#114A46";
const TEAL_DARK = "#0B3633";
const TEAL_LIGHT = "#DCE8E0";
const TERRA = "#A84D38";
const TERRA_DARK = "#8F3E2C";
const SAND = "#F7F5F0";
const CANVAS = "#EDE8E1";
const CHARCOAL = "#1E2524";
const MUTED = "#7A8481";
const BORDER = "#E3DDD4";
const BORDER_SUB = "#EFEBE4";
const WHITE = "#FFFFFF";
const FONT = "'Plus Jakarta Sans', system-ui, sans-serif";

/* ============================================================
   DESKTOP DESIGN HELPERS
============================================================ */
const PAGE_SIZE = 8;

const SORT_OPTIONS = [
    { value: "rating", label: "Top Rated" },
    { value: "priceLow", label: "Price: Low to High" },
    { value: "priceHigh", label: "Price: High to Low" },
    { value: "newest", label: "Newest" },
];

// Resolve the design's expected fields against the project's actual product shape.
const getName = (p) => p.title || p.name || "Untitled Product";
const getImage = (p) =>
    p.imageUrl ||
    p.thumbnail ||
    p.image ||
    "https://picsum.photos/seed/" + (p.id || "x") + "/400/400";
// price = MRP. For a product with variants this is the price the CARD shows (listPriceSummary): the MAIN price when the
// main product is on sale, otherwise the lowest variant price (the card then says "From" and explains the range).
// Sorting and price filters use the same number, so what you filter by is what you see.
const getMrp = (p) => listPriceSummary(p).price;
const getDiscount = (p) => {
    if (p.discountExpiry) {
        const expiry = new Date(p.discountExpiry).getTime();
        if (Date.now() > expiry) return 0;
    }
    return Number(p.discount || 0);
};

const getPrice = (p) => {
    const mrp = getMrp(p);
    const discount = getDiscount(p);

    return mrp - (mrp * discount) / 100;
};
// Units that can be bought across ALL options of the product (0 = nothing can be bought; untracked = unlimited -> big cap).
// A sold-out MAIN counter must not hide variants that are in stock (see listStockSummary).
const getStock = (p) => {
    const s = listStockSummary(p);
    return s.out ? 0 : (s.units ?? 999999);
};
const getMaxStock = (p) =>
    Number(p.maxStock || 0) || Math.max(getStock(p), 100);

/* ── Stars (amber, matching HTML design) ── */
const Stars = ({ rating = 0, size = 12 }) => {
    const full = Math.round(rating);
    return (
        <span style={{ display: "flex", alignItems: "center", gap: "1px" }}>
            {[0, 1, 2, 3, 4].map((i) => (
                <Star
                    key={i}
                    size={size}
                    style={{ color: "#F59E0B" }}
                    fill={i < full ? "#F59E0B" : "none"}
                    strokeWidth={1.5}
                />
            ))}
        </span>
    );
};

/* ── PRODUCT CARD (Pelago HTML design) ── */
const NewProductCard = ({
    product,
    onAddToCart,
    onToggleWishlist,
    isWishlisted,
    quantity,
    onDecrement,
}) => {
    const navigate = useNavigate();
    const name = getName(product);
    const mrp = getMrp(product);
    const discount = getDiscount(product);
    const discountedPrice = getPrice(product);
    const stock = getStock(product);
    const maxStock = getMaxStock(product);
    const pct = Math.max(0, Math.min(100, Math.round((stock / maxStock) * 100)));
    // Phase 1/4: explicit price + availability rules for products with variants
    const summary = listPriceSummary(product);
    const stockInfo = listStockSummary(product);
    const choose = needsOptionChoice(product); // card cannot "add the product": shopper must pick an option
    const showCount = !stockInfo.out && stockInfo.units != null && !stockInfo.multi; // a number only for ONE tracked option
    const isLow = showCount && pct <= 20;
    const isOut = stockInfo.out;

    return (
        <article
            data-pid={product.id}
            className="product-card"
            style={{
                background: WHITE,
                borderRadius: "20px",
                border: `1px solid ${BORDER}`,
                padding: "12px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                transition: "box-shadow 0.2s",
                fontFamily: FONT,
                cursor: "default",
            }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,0.10)"}
            onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
        >
            {/* Image area */}
            <div>
                <div
                    onClick={() => navigate(`/product/${product.id}`, { state: { product } })}
                    style={{
                        position: "relative",
                        width: "100%",
                        aspectRatio: "1 / 1",
                        borderRadius: "14px",
                        background: SAND,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        overflow: "hidden",
                        marginBottom: "12px",
                        border: `1px solid ${BORDER_SUB}`,
                        cursor: "pointer",
                    }}
                >
                    <img
                        src={getImage(product)}
                        alt={name}
                        loading="lazy"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                    {/* Category badge */}
                    <span style={{
                        position: "absolute", top: "8px", left: "8px",
                        background: CHARCOAL, color: WHITE,
                        fontSize: "9px", fontWeight: 700,
                        padding: "2px 7px", borderRadius: "4px",
                        letterSpacing: "0.06em", textTransform: "uppercase",
                    }}>
                        {product.badge || product.category || "Product"}
                    </span>
                    {/* Wishlist heart */}
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggleWishlist(product); }}
                        aria-label="Toggle wishlist"
                        style={{
                            position: "absolute", top: "8px", right: "8px",
                            width: "28px", height: "28px", borderRadius: "50%",
                            background: "rgba(255,255,255,0.90)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            border: "none", cursor: "pointer",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.10)",
                            transition: "color 0.15s",
                        }}
                    >
                        <Heart
                            size={14}
                            style={{ color: isWishlisted ? "#EF4444" : MUTED }}
                            fill={isWishlisted ? "#EF4444" : "none"}
                        />
                    </button>
                </div>

                {/* Stars */}
                <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "4px" }}>
                    <Stars rating={product.rating} />
                    <span style={{ fontSize: "11px", color: MUTED, fontWeight: 500 }}>
                        ({Number(product.rating || 0).toFixed(1)})
                    </span>
                </div>

                {/* Title */}
                <h4 style={{
                    fontWeight: 700, fontSize: "14px", color: CHARCOAL,
                    lineHeight: "1.35", marginBottom: "4px",
                    display: "-webkit-box", WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: "38px",
                }}>
                    {name}
                </h4>

                {/* Price */}
                <div style={{ marginBottom: "10px" }}>
                    {discount > 0 ? (
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                            {summary.prefix && (
                                <span style={{ fontSize: "11px", fontWeight: 600, color: MUTED }}>{summary.prefix}</span>
                            )}
                            <span style={{ fontSize: "14px", fontWeight: 900, color: CHARCOAL }}>
                                ₹{discountedPrice.toFixed(2)}
                            </span>
                            <span style={{ fontSize: "11px", color: MUTED, textDecoration: "line-through" }}>
                                ₹{mrp.toFixed(2)}
                            </span>
                            <span style={{
                                fontSize: "10px", fontWeight: 800,
                                background: "#FEE2E2", color: "#B91C1C",
                                padding: "1px 5px", borderRadius: "4px",
                            }}>
                                {discount}% OFF
                            </span>
                            {product.discountExpiry && (
                                <div style={{ fontSize: "10px", color: "#D97706", fontWeight: 500, width: "100%" }}>
                                    Ends: {new Date(product.discountExpiry).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
                                </div>
                            )}
                        </div>
                    ) : (
                        <span style={{ fontSize: "14px", fontWeight: 900, color: CHARCOAL }}>
                            {summary.prefix && (
                                <span style={{ fontSize: "11px", fontWeight: 600, color: MUTED, marginRight: "4px" }}>{summary.prefix}</span>
                            )}
                            ₹{mrp.toFixed(2)}
                        </span>
                    )}
                    {summary.note && (
                        <div style={{ fontSize: "11px", color: MUTED, marginTop: "2px" }}>{summary.note}</div>
                    )}
                </div>

                {/* Stock bar */}
                {showCount && (
                    <div style={{ marginBottom: "10px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: MUTED, fontWeight: 500, marginBottom: "4px" }}>
                            <span>Available</span>
                            <span style={{ color: isLow ? "#B91C1C" : "#065F46", fontWeight: 600 }}>{stock} units</span>
                        </div>
                        <div style={{ width: "100%", background: SAND, borderRadius: "999px", height: "6px", overflow: "hidden" }}>
                            <div style={{
                                background: isLow ? "#EF4444" : "#059669",
                                height: "100%", width: `${pct}%`, borderRadius: "999px",
                            }} />
                        </div>
                    </div>
                )}
                {!showCount && !isOut && (
                    <div style={{ marginBottom: "10px" }}>
                        <span style={{
                            fontSize: "11px", fontWeight: 700,
                            background: "#D1FAE5", color: "#065F46",
                            padding: "2px 8px", borderRadius: "5px",
                        }}>In Stock</span>
                    </div>
                )}
                {isOut && (
                    <div style={{ marginBottom: "10px" }}>
                        <span style={{
                            fontSize: "11px", fontWeight: 700,
                            background: "#FEE2E2", color: "#B91C1C",
                            padding: "2px 8px", borderRadius: "5px",
                        }}>Out of Stock</span>
                    </div>
                )}
            </div>

            {/* CTA button */}
            <div style={{ marginTop: "4px" }}>
                {isOut ? (
                    <button
                        disabled
                        style={{
                            width: "100%", height: "36px",
                            background: BORDER, color: MUTED,
                            borderRadius: "12px", border: "none",
                            fontSize: "12px", fontWeight: 700, cursor: "not-allowed",
                            fontFamily: FONT,
                        }}
                    >
                        Out of Stock
                    </button>
                ) : choose ? (
                    <button
                        onClick={() => navigate(`/product/${product.id}`, { state: { product } })}
                        style={{
                            width: "100%", height: "36px",
                            background: TEAL, color: WHITE,
                            borderRadius: "12px", border: "none",
                            fontSize: "12px", fontWeight: 700, cursor: "pointer",
                            fontFamily: FONT, transition: "background 0.15s",
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = TEAL_DARK}
                        onMouseLeave={e => e.currentTarget.style.background = TEAL}
                    >
                        Choose options
                    </button>
                ) : quantity > 0 ? (
                    <div style={{
                        width: "100%", height: "36px",
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        border: `1px solid ${TEAL}`, borderRadius: "12px", overflow: "hidden",
                    }}>
                        <button
                            onClick={() => onDecrement(product)}
                            style={{
                                flex: 1, height: "100%", background: "transparent", border: "none",
                                fontSize: "18px", fontWeight: 700, color: TEAL, cursor: "pointer",
                                fontFamily: FONT,
                            }}
                        >−</button>
                        <span style={{ fontWeight: 700, fontSize: "14px", color: CHARCOAL, minWidth: "24px", textAlign: "center" }}>
                            {quantity}
                        </span>
                        <button
                            onClick={() => onAddToCart(product)}
                            disabled={quantity >= stock}
                            style={{
                                flex: 1, height: "100%", background: "transparent", border: "none",
                                fontSize: "18px", fontWeight: 700,
                                color: quantity >= stock ? MUTED : TEAL,
                                cursor: quantity >= stock ? "not-allowed" : "pointer",
                                fontFamily: FONT,
                            }}
                        >+</button>
                    </div>
                ) : (
                    <button
                        onClick={() => onAddToCart(product)}
                        style={{
                            width: "100%", height: "36px",
                            background: TEAL, color: WHITE,
                            borderRadius: "12px", border: "none",
                            fontSize: "12px", fontWeight: 700, cursor: "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
                            fontFamily: FONT, transition: "background 0.15s",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.10)",
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = TEAL_DARK}
                        onMouseLeave={e => e.currentTarget.style.background = TEAL}
                    >
                        <ShoppingCart size={13} />
                        Add to Cart
                    </button>
                )}
            </div>
        </article>
    );
};

/* ── Filter sidebar helpers ── */
const SectionLabel = ({ children }) => (
    <p
        style={{
            textTransform: "uppercase", fontWeight: 700,
            color: MUTED, letterSpacing: "0.08em",
            fontSize: "11px", marginBottom: "8px",
        }}
    >
        {children}
    </p>
);

const CheckRow = ({ checked, onChange, children, count }) => (
    <label style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        cursor: "pointer", userSelect: "none", padding: "4px 0",
    }}>
        <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input
                type="checkbox"
                checked={checked}
                onChange={onChange}
                style={{
                    width: "14px", height: "14px",
                    borderRadius: "4px", accentColor: TEAL, cursor: "pointer",
                }}
            />
            <span style={{ fontSize: "12px", fontWeight: 500, color: CHARCOAL }}>{children}</span>
        </span>
        {count !== undefined && (
            <span style={{ fontSize: "11px", color: MUTED }}>{count}</span>
        )}
    </label>
);

/* ============================================================
   PRODUCTS PAGE
============================================================ */
const ProductsPage = () => {
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const products = useSelector((state) => state.products.product);
    const cartItems = useSelector((state) => state.cart.cartItems);
    const wishlistItems = useSelector((state) => state.wishlist.wishlistItems);
    const user = useSelector((state) => state.user.user);
    const [loading, setLoading] = useState(false);
    const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
    const [recentlyViewedIds, setRecentlyViewedIds] = useState([]);

    // Mobile layout (≤640px) — desktop layout is rendered untouched above this breakpoint
    const isMobile = useIsMobile(640);
    const searchInputRef = useRef(null);

    // FILTER STATES (shared by mobile layout / FiltersSidebar)
    const [selectedCategories, setSelectedCategories] = useState([]);
    const [minPrice, setMinPrice] = useState(0);
    const [minRating, setMinRating] = useState(0);
    const [sort, setSort] = useState("");
    const [search, setSearch] = useState("");

    // DESKTOP-ONLY FILTER STATE (richer sidebar from the new design)
    const [filterSearch, setFilterSearch] = useState("");
    const [selectedDepartments, setSelectedDepartments] = useState([]);
    const [priceMin, setPriceMin] = useState("");
    const [priceMax, setPriceMax] = useState("");
    const [ratingThresholds, setRatingThresholds] = useState([]);
    const [availability, setAvailability] = useState([]);
    const [activeChip, setActiveChip] = useState("all");
    const [deskSearch, setDeskSearch] = useState("");
    const [deskSort, setDeskSort] = useState("rating");
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
    const [applyTick, setApplyTick] = useState(0);

    // ── TASK 2.2: autocomplete + search history ──
    // One set of state serves both layouts; only one layout is mounted at a
    // time (`isMobile`), so there's no risk of the two dropdowns colliding.
    // `activeSearchField` records WHICH input is focused, because the two
    // layouts keep their query in different state (`search` vs `deskSearch`).
    const [activeSearchField, setActiveSearchField] = useState(null); // "mobile" | "desktop" | null
    // Lazy initial state, not a mount effect: reading localStorage is a cheap
    // synchronous call, and doing it here avoids a setState-in-effect cascade.
    const [recentSearches, setRecentSearches] = useState(() => getRecentSearches());
    // `suggestFor` records WHICH query `suggestResults` belongs to. Keeping it
    // lets the render derive both "are these results current?" and "are we
    // still loading?" instead of tracking a separate loading flag — which also
    // means results for a stale query can never be shown against a newer one.
    const [suggestResults, setSuggestResults] = useState([]);
    const [suggestFor, setSuggestFor] = useState("");

    const sidebarRef = useRef(null);
    const chipsRef = useRef(null);
    const gridRef = useRef(null);
    // Tracks product ids that have already played their entrance animation, so
    // switching sort/filter doesn't re-flash cards that are already on screen.
    const animatedCardIdsRef = useRef(new Set());

    // CLEAR FILTERS (mobile)
    const clearFilters = useCallback(() => {
        setSelectedCategories([]);
        setMinPrice(0);
        setMinRating(0);
        setSort("");
        setSearch("");
    }, []);

    // FETCH PRODUCTS
    const fetchProducts = async () => {
        try {
            setLoading(true);

            const { data: productRows, error: productError } = await supabase
                .from("products")
                .select("*")
                .neq("status", "draft");
            if (productError) throw productError;

            const { data: reviewsData } = await supabase.from("reviews").select("product_id, rating");

            const ratingsMap = {};
            (reviewsData || []).forEach((review) => {
                const pid = String(review.product_id);
                if (!ratingsMap[pid]) ratingsMap[pid] = { total: 0, count: 0 };
                ratingsMap[pid].total += Number(review.rating || 0);
                ratingsMap[pid].count += 1;
            });

            const productArray = mapProductRows(productRows).map((p) => {
                const ratingInfo = ratingsMap[p.id];
                const avgRating = ratingInfo ? ratingInfo.total / ratingInfo.count : 0;

                return {
                    ...p,
                    rating: avgRating,
                    reviewCount: ratingInfo ? ratingInfo.count : 0,
                };
            });

            dispatch(addProduct(productArray));
        } catch (error) {
            console.log("Error fetching products:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchProducts(); // re-fetch on mount to respect admin status changes
        setRecentlyViewedIds(getRecentlyViewedIds());
    }, []);

    // Lock body when mobile filter is open
    useEffect(() => {
        if (mobileFilterOpen) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "";
        }
        return () => {
            document.body.style.overflow = "";
        };
    }, [mobileFilterOpen]);

    // FILTER & SORT & GROUP PRODUCTS (mobile layout)
    const { filteredProducts, groupedProducts } = useMemo(() => {
        let filtered = products.filter((product) => {
            return (
                (selectedCategories.length
                    ? selectedCategories.includes(product.category)
                    : true) &&
                getMrp(product) >= minPrice &&
                Number(product.rating || 0) >= minRating &&
                product.status !== "draft" &&
                product.title?.toLowerCase().includes(search.toLowerCase())
            );
        });

        if (sort === "priceLow") filtered.sort((a, b) => getMrp(a) - getMrp(b));
        else if (sort === "priceHigh") filtered.sort((a, b) => getMrp(b) - getMrp(a));
        else if (sort === "rating")
            filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));

        const grouped = filtered.reduce((acc, product) => {
            if (!acc[product.category]) {
                acc[product.category] = [];
            }
            acc[product.category].push(product);
            return acc;
        }, {});

        return { filteredProducts: filtered, groupedProducts: grouped };
    }, [products, selectedCategories, minPrice, minRating, sort, search]);

    // UNIQUE CATEGORIES
    const categories = useMemo(
        () => [...new Set(products.map((p) => p.category))],
        [products],
    );

    /* ── TASK 2.2: autocomplete + search history ────────────────────────── */

    // The query of whichever input is focused.
    const activeSearchQuery = activeSearchField === "desktop" ? deskSearch : search;

    const trimmedSearchQuery = String(activeSearchQuery || "").trim();

    // Debounced suggestion fetch. 250ms is deliberately shorter than
    // SearchBar.jsx's 300ms default — this fires a cheap indexed RPC, not a
    // full catalog re-filter, and the dropdown needs to feel live.
    //
    // Every setState here is inside the async callback, never in the effect
    // body, so typing doesn't trigger a synchronous render cascade.
    useEffect(() => {
        if (!activeSearchField) return;
        if (trimmedSearchQuery.length < 2) return;
        let active = true;
        const timer = setTimeout(() => {
            searchProducts(trimmedSearchQuery, { catalog: products, limit: 8 })
                .then(({ results }) => {
                    if (!active) return;
                    setSuggestResults(results);
                    setSuggestFor(trimmedSearchQuery);
                })
                .catch(() => {
                    if (!active) return;
                    setSuggestResults([]);
                    setSuggestFor(trimmedSearchQuery);
                });
        }, 250);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [trimmedSearchQuery, activeSearchField, products]);

    // Derived, so a stale result set is never rendered against a newer query.
    const suggestionsAreCurrent = suggestFor === trimmedSearchQuery;
    const visibleSuggestResults = suggestionsAreCurrent ? suggestResults : [];
    const suggestLoading = trimmedSearchQuery.length >= 2 && !suggestionsAreCurrent;

    // Commit a term: apply it to whichever input is active, persist it, close.
    const commitSearch = useCallback(
        (term) => {
            const cleaned = String(term || "").trim();
            if (!cleaned) return;
            if (activeSearchField === "desktop") setDeskSearch(cleaned);
            else setSearch(cleaned);
            setActiveSearchField(null);
            addRecentSearch(cleaned);
            setRecentSearches(getRecentSearches());
        },
        [activeSearchField],
    );

    // Picking a product goes straight to its PDP — the user named the exact
    // item, so making them read a one-result grid first is a wasted step.
    const handlePickProduct = useCallback(
        (product) => {
            setActiveSearchField(null);
            addRecentSearch(product.title || product.name || "");
            setRecentSearches(getRecentSearches());
            navigate(`/product/${product.id}`);
        },
        [navigate],
    );

    const handleRemoveRecent = useCallback((term) => {
        removeRecentSearch(term);
        setRecentSearches(getRecentSearches());
    }, []);

    const handleClearRecents = useCallback(() => {
        clearRecentSearches();
        setRecentSearches([]);
    }, []);

    // Shared props for both layouts' dropdowns.
    const suggestionProps = {
        results: visibleSuggestResults,
        categories,
        recentSearches,
        loading: suggestLoading,
        onPickTerm: commitSearch,
        onPickProduct: handlePickProduct,
        onRemoveRecent: handleRemoveRecent,
        onClearRecents: handleClearRecents,
    };

    // Independent of the search/filter state — recently viewed is a standing
    // shelf, not something the catalog filters should hide.
    const recentlyViewedProducts = useMemo(() => {
        if (!recentlyViewedIds.length || !products.length) return [];
        const byId = new Map(products.map((p) => [String(p.id), p]));
        return recentlyViewedIds.map((id) => byId.get(id)).filter(Boolean);
    }, [recentlyViewedIds, products]);

    // MAX PRICE FOR FILTER
    const maxPriceValue = useMemo(() => {
        if (products.length === 0) return 2000;
        return Math.max(...products.map((p) => getMrp(p)));
    }, [products]);

    // MOBILE: total cart count (drives the app-bar badge + bottom-nav dot)
    const cartCount = useMemo(
        () => cartItems.reduce((acc, item) => acc + (item.quantity || 0), 0),
        [cartItems],
    );

    // Count active filters
    const activeFilterCount =
        selectedCategories.length +
        (minPrice > 0 ? 1 : 0) +
        (minRating > 0 ? 1 : 0) +
        (sort ? 1 : 0) +
        (search ? 1 : 0);

    /* ============================================================
         DESKTOP DERIVED DATA (new design, independent of mobile state)
      ============================================================ */
    const categoryCounts = useMemo(() => {
        const map = {};
        products.forEach((p) => {
            if (!p.category) return;
            map[p.category] = (map[p.category] || 0) + 1;
        });
        return map;
    }, [products]);

    const displayedDepartments = useMemo(
        () =>
            categories
                .filter(Boolean)
                .filter((c) => c.toLowerCase().includes(filterSearch.toLowerCase())),
        [categories, filterSearch],
    );

    const minRatingDesk = useMemo(
        () => (ratingThresholds.length ? Math.min(...ratingThresholds) : 0),
        [ratingThresholds],
    );

    const desktopFiltered = useMemo(() => {
        const minP = priceMin === "" ? 0 : Number(priceMin);
        const maxP = priceMax === "" ? Infinity : Number(priceMax);

        let filtered = products.filter((p) => {
            const stock = getStock(p);
            const maxStock = getMaxStock(p);
            const pctv = (stock / maxStock) * 100;

            if (
                selectedDepartments.length &&
                !selectedDepartments.includes(p.category)
            )
                return false;
            if (p.status === "draft") return false;
            if (activeChip !== "all" && p.category !== activeChip) return false;
            if (getPrice(p) < minP || getPrice(p) > maxP) return false;
            if (Number(p.rating || 0) < minRatingDesk) return false;
            if (availability.length) {
                const isInStock = stock > 0;
                const isLowStock = stock > 0 && pctv <= 20;
                const matches =
                    (availability.includes("inStock") && isInStock) ||
                    (availability.includes("lowStock") && isLowStock);
                if (!matches) return false;
            }
            if (
                deskSearch &&
                !getName(p).toLowerCase().includes(deskSearch.toLowerCase())
            )
                return false;
            return true;
        });

        if (deskSort === "priceLow")
            filtered = [...filtered].sort((a, b) => getPrice(a) - getPrice(b));
        else if (deskSort === "priceHigh")
            filtered = [...filtered].sort((a, b) => getPrice(b) - getPrice(a));
        else if (deskSort === "rating")
            filtered = [...filtered].sort(
                (a, b) => (b.rating || 0) - (a.rating || 0),
            );
        else if (deskSort === "newest")
            filtered = [...filtered].sort(
                (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
            );

        return filtered;
    }, [
        products,
        selectedDepartments,
        activeChip,
        priceMin,
        priceMax,
        minRatingDesk,
        availability,
        deskSearch,
        deskSort,
    ]);

    const desktopVisible = useMemo(
        () => desktopFiltered,
        [desktopFiltered],
    );

    const desktopGrouped = useMemo(() => {
        return desktopVisible.reduce((acc, p) => {
            const c = p.category || "Other";
            if (!acc[c]) acc[c] = [];
            acc[c].push(p);
            return acc;
        }, {});
    }, [desktopVisible]);

    useEffect(() => {
        setVisibleCount(PAGE_SIZE);
    }, [
        selectedDepartments,
        activeChip,
        priceMin,
        priceMax,
        minRatingDesk,
        availability,
        deskSearch,
        deskSort,
    ]);

    /* ---------- DESKTOP CART / WISHLIST HELPERS ---------- */
    const cartQty = useCallback(
        (id) => {
            const item = cartItems.find((x) => String(x.id) === String(id));
            return item ? item.quantity : 0;
        },
        [cartItems],
    );

    const handleAddToCart = useCallback(
        (product) => {
            if (!user) {
                navigate("/login");
                return;
            }
            const qty = nextAddQuantity(cartItems, product.id);
            dispatch(addCart(product));
            upsertCartItem(user.uid, product, qty);
        },
        [dispatch, navigate, user, cartItems],
    );

    const handleDecrement = useCallback(
        (product) => {
            const qty = nextRemoveQuantity(cartItems, product.id);
            dispatch(removeCart(String(product.id)));
            decrementOrRemoveCartItem(user?.uid, product.id, qty);
        },
        [dispatch, cartItems, user],
    );

    const isWishlisted = useCallback(
        (id) => wishlistItems.some((item) => String(item.id) === String(id)),
        [wishlistItems],
    );

    const handleToggleWishlist = useCallback(
        async (product) => {
            if (!user) {
                navigate("/login");
                return;
            }
            const productId = String(product.id);
            try {
                if (isWishlisted(productId)) {
                    dispatch(removeWishlist(productId));
                    await removeWishlistItem(user.uid, productId);
                } else {
                    const reduxItem = {
                        userId: user.uid,
                        productId,
                        id: productId,
                        title: getName(product),
                        price: getPrice(product),
                        image: getImage(product),
                        category: product.category,
                        addedAt: new Date().toISOString(),
                    };
                    dispatch(addWishlist(reduxItem));
                    await addWishlistItem(user.uid, product);
                }
            } catch (error) {
                console.log("Wishlist error:", error);
            }
        },
        [dispatch, navigate, user, isWishlisted],
    );

    const toTitleCase = (text) => {
        if (!text) return "";

        return text
            .toLowerCase()
            .split(" ")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
    };

    const toggleDepartment = (cat) =>
        setSelectedDepartments((prev) =>
            prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
        );

    const toggleRating = (threshold) =>
        setRatingThresholds((prev) =>
            prev.includes(threshold)
                ? prev.filter((t) => t !== threshold)
                : [...prev, threshold],
        );

    const toggleAvailability = (key) =>
        setAvailability((prev) =>
            prev.includes(key) ? prev.filter((a) => a !== key) : [...prev, key],
        );

    const clearAllFilters = useCallback(() => {
        setFilterSearch("");
        setSelectedDepartments([]);
        setPriceMin("");
        setPriceMax("");
        setRatingThresholds([]);
        setAvailability([]);
        setActiveChip("all");
        setDeskSearch("");
        setDeskSort("rating");
    }, []);

    const applyFilters = () => {
        setApplyTick((t) => t + 1);
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    /* ---------- DESKTOP ANIMATIONS ---------- */
    useGSAP(
        () => {
            if (sidebarRef.current) {
                gsap.from(sidebarRef.current, {
                    x: -30,
                    opacity: 0,
                    duration: 0.6,
                    ease: "power2.out",
                });
            }
        },
        { scope: sidebarRef },
    );

    useGSAP(
        () => {
            const chips = chipsRef.current?.querySelectorAll(".cat-chip");
            if (chips?.length) {
                gsap.from(chips, {
                    y: 10,
                    opacity: 0,
                    duration: 0.4,
                    stagger: 0.05,
                    ease: "power2.out",
                });
            }
        },
        { dependencies: [categories.length], scope: chipsRef },
    );

    useGSAP(
        () => {
            const cards = gridRef.current?.querySelectorAll(".product-card");
            if (!cards?.length) return;

            // Only fade in cards that haven't been shown yet — otherwise switching
            // sort/filters re-hides (opacity: 0) cards already on screen, which
            // reads as a flicker/flash rather than a smooth transition.
            const newCards = Array.from(cards).filter(
                (el) => !animatedCardIdsRef.current.has(el.dataset.pid),
            );
            if (!newCards.length) return;

            newCards.forEach((el) => animatedCardIdsRef.current.add(el.dataset.pid));
            gsap.fromTo(
                newCards,
                { y: 20, opacity: 0 },
                {
                    y: 0,
                    opacity: 1,
                    duration: 0.35,
                    stagger: 0.05,
                    ease: "power2.out",
                    clearProps: "opacity,transform",
                }
            );
        },
        {
            dependencies: [activeChip, deskSort, applyTick, loading],
            scope: gridRef,
        },
    );

    const totalProductCount = products.length;

    /* ============================================================
         MOBILE LAYOUT (≤640px) — matches the reference design.
         All logic above is shared; this is layout only.
      ============================================================ */
    if (isMobile) {
        const navIcon = (color) => ({ color });
        return (
            <div
                className="min-h-screen bg-[var(--color-background)]"
                style={{
                    fontFamily: "Inter, sans-serif",
                    overflowX: "hidden",
                    maxWidth: "100vw",
                }}
            >
                {/* ── SEARCH SECTION (fixed flush under the global mobile header, 56px) ── */}
                <div
                    className="fixed inset-x-0 z-40 flex items-center"
                    style={{
                        top: "56px",
                        height: "76px",
                        background: "var(--color-background)",
                        padding: "16px 20px",
                        gap: "12px",
                    }}
                >
                    <div className="relative flex-1">
                        <SearchIcon
                            size={15}
                            style={{
                                color: "var(--color-muted)",
                                position: "absolute",
                                left: "16px",
                                top: "50%",
                                transform: "translateY(-50%)",
                                pointerEvents: "none",
                            }}
                        />
                        <input
                            ref={searchInputRef}
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onFocus={() => setActiveSearchField("mobile")}
                            onBlur={() => setActiveSearchField(null)}
                            onKeyDown={(e) => e.key === "Enter" && commitSearch(search)}
                            placeholder="Search for items..."
                            className="w-full outline-none mobile-search-input"
                            style={{
                                background: "var(--color-surface-muted)",
                                borderRadius: "12px",
                                height: "44px",
                                padding: "13px 16px 14px 48px",
                                fontSize: "14px",
                                fontWeight: 400,
                                color: "var(--color-ink)",
                                fontFamily: "Inter, sans-serif",
                            }}
                        />
                        {/* Task 2.2 — autocomplete dropdown */}
                        {activeSearchField === "mobile" && (
                            <SearchSuggestions query={search} {...suggestionProps} />
                        )}
                    </div>
                    {/* Filter trigger — opens the full filter sheet (all desktop filters) */}
                    <button
                        onClick={() => setMobileFilterOpen(true)}
                        aria-label="Filters"
                        className="relative flex items-center justify-center flex-shrink-0"
                        style={{
                            width: "44px",
                            height: "44px",
                            background: "var(--color-surface-muted)",
                            borderRadius: "12px",
                        }}
                    >
                        <SlidersHorizontal size={18} color="var(--color-muted)" />
                        {activeFilterCount > 0 && (
                            <span
                                className="absolute flex items-center justify-center"
                                style={{
                                    top: "-4px",
                                    right: "-4px",
                                    minWidth: "16px",
                                    height: "16px",
                                    padding: "0 4px",
                                    background: "var(--color-primary)",
                                    color: "var(--color-inverse)",
                                    border: "1px solid var(--color-background)",
                                    borderRadius: "9999px",
                                    fontSize: "9px",
                                    fontWeight: 700,
                                    lineHeight: 1,
                                }}
                            >
                                {activeFilterCount}
                            </span>
                        )}
                    </button>
                </div>

                {/* ── SCROLLABLE CONTENT (grouped by category, like desktop) ── */}
                {/* paddingTop = 56px header + 76px search bar + 8px gap. paddingBottom clears the global tab bar. */}
                <main
                    className="px-5"
                    style={{ paddingTop: "140px", paddingBottom: "72px" }}
                >
                    {!loading && recentlyViewedProducts.length > 0 && (
                        <div style={{ marginBottom: "24px" }}>
                            <h2
                                style={{
                                    fontSize: "18px",
                                    fontWeight: 700,
                                    color: "var(--color-ink)",
                                    marginBottom: "12px",
                                }}
                            >
                                Recently Viewed
                            </h2>
                            <div
                                className="flex no-scrollbar"
                                style={{ gap: "16px", overflowX: "auto" }}
                            >
                                {recentlyViewedProducts.map((product) => (
                                    <div key={product.id} style={{ width: "160px", flexShrink: 0 }}>
                                        <ProductCard product={product} variant="mobile" />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {loading ? (
                        <div className="grid grid-cols-2" style={{ gap: "16px" }}>
                            {[...Array(6)].map((_, i) => (
                                <ProductCardSkeleton key={i} />
                            ))}
                        </div>
                    ) : Object.keys(groupedProducts).length === 0 ? (
                        <div
                            className="flex flex-col items-center justify-center text-center"
                            style={{ gap: "14px", minHeight: "40vh" }}
                        >
                            <p
                                style={{ color: "var(--color-muted)", fontSize: "13px", fontWeight: 600 }}
                            >
                                {activeFilterCount > 0
                                    ? "No products match your filters."
                                    : "No products available right now."}
                            </p>
                            {activeFilterCount > 0 && (
                                <button
                                    onClick={clearFilters}
                                    style={{
                                        color: "var(--color-primary)",
                                        fontWeight: 700,
                                        fontSize: "12px",
                                    }}
                                >
                                    Clear filters
                                </button>
                            )}
                        </div>
                    ) : (
                        Object.keys(groupedProducts).map((category) => (
                            <div key={category} style={{ marginBottom: "24px" }}>
                                <div
                                    className="flex items-center justify-between"
                                    style={{ marginBottom: "12px" }}
                                >
                                    <h2
                                        style={{
                                            fontSize: "18px",
                                            fontWeight: 700,
                                            color: "var(--color-ink)",
                                            textTransform: "capitalize",
                                        }}
                                    >
                                        {category}
                                    </h2>
                                    <span
                                        style={{
                                            fontSize: "12px",
                                            fontWeight: 500,
                                            color: "var(--color-muted)",
                                        }}
                                    >
                                        {groupedProducts[category].length} items
                                    </span>
                                </div>
                                <div className="grid grid-cols-2" style={{ gap: "16px" }}>
                                    {groupedProducts[category].map((product) => (
                                        <ProductCard
                                            key={product.id}
                                            product={product}
                                            variant="mobile"
                                        />
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </main>

                {/* ── BOTTOM NAV BAR — superseded by the global MobileNav tab bar; hidden. ── */}
                <nav
                    className="fixed bottom-0 inset-x-0 z-50 flex items-center justify-around"
                    style={{
                        display: "none",
                        height: "64px",
                        background: "color-mix(in srgb, var(--color-background) 80%, transparent)",
                        backdropFilter: "blur(6px)",
                        WebkitBackdropFilter: "blur(6px)",
                        borderRadius: "12px 12px 0 0",
                        boxShadow:
                            "0px 10px 15px -3px rgba(0,0,0,0.1), 0px 4px 6px -4px rgba(0,0,0,0.1)",
                    }}
                >
                    {/* Home — active on this route per spec */}
                    <button
                        onClick={() => navigate("/")}
                        className="flex flex-col items-center justify-center"
                        style={{ gap: "4px", ...navIcon("var(--color-primary)") }}
                    >
                        <HomeIcon size={20} />
                        <span style={{ fontSize: "10px", fontWeight: 500 }}>Home</span>
                    </button>
                    {/* Search */}
                    <button
                        onClick={() => {
                            window.scrollTo({ top: 0, behavior: "smooth" });
                            searchInputRef.current?.focus();
                        }}
                        className="flex flex-col items-center justify-center"
                        style={{ gap: "4px", ...navIcon("var(--color-body)") }}
                    >
                        <SearchIcon size={20} />
                        <span style={{ fontSize: "10px", fontWeight: 500 }}>Search</span>
                    </button>
                    {/* Cart — with red dot badge */}
                    <button
                        onClick={() => navigate("/cart")}
                        className="flex flex-col items-center justify-center"
                        style={{ gap: "4px", ...navIcon("var(--color-body)") }}
                    >
                        <span className="relative flex items-center justify-center">
                            <ShoppingCart size={20} />
                            {cartCount > 0 && (
                                <span
                                    style={{
                                        position: "absolute",
                                        top: "-2px",
                                        right: "-3px",
                                        width: "8px",
                                        height: "8px",
                                        background: "var(--color-primary)",
                                        borderRadius: "9999px",
                                    }}
                                />
                            )}
                        </span>
                        <span style={{ fontSize: "10px", fontWeight: 500 }}>Cart</span>
                    </button>
                    {/* Wishlist */}
                    <button
                        onClick={() => navigate("/wishlist")}
                        className="flex flex-col items-center justify-center"
                        style={{ gap: "4px", ...navIcon("var(--color-body)") }}
                    >
                        <HeartIcon size={20} />
                        <span style={{ fontSize: "10px", fontWeight: 500 }}>Wishlist</span>
                    </button>
                    {/* Profile */}
                    <button
                        onClick={() => navigate("/myprofile")}
                        className="flex flex-col items-center justify-center"
                        style={{ gap: "4px", ...navIcon("var(--color-body)") }}
                    >
                        <UserIcon size={20} />
                        <span style={{ fontSize: "10px", fontWeight: 500 }}>Profile</span>
                    </button>
                </nav>

                {/* ── FILTER BOTTOM SHEET (all desktop filter operations) ── */}
                <div
                    className={`mobile-bottom-sheet-backdrop ${mobileFilterOpen ? "open" : ""}`}
                    onClick={() => setMobileFilterOpen(false)}
                />
                <div
                    className={`mobile-bottom-sheet ${mobileFilterOpen ? "open" : ""}`}
                    style={{ fontFamily: "Inter, sans-serif" }}
                >
                    <div className="mobile-bottom-sheet-handle" />
                    <button
                        onClick={() => setMobileFilterOpen(false)}
                        aria-label="Close filters"
                        className="absolute flex items-center justify-center"
                        style={{
                            top: "12px",
                            right: "16px",
                            width: "32px",
                            height: "32px",
                            color: "var(--color-muted)",
                            fontSize: "18px",
                            zIndex: 2,
                        }}
                    >
                        ✕
                    </button>
                    <div className="px-6 pb-8 pt-2">
                        <FiltersSidebar
                            categories={categories}
                            selectedCategories={selectedCategories}
                            setSelectedCategories={setSelectedCategories}
                            setMinPrice={setMinPrice}
                            minPrice={minPrice}
                            maxPrice={maxPriceValue}
                            setMinRating={setMinRating}
                            setSort={setSort}
                            clearFilters={clearFilters}
                            search={search}
                            setSearch={setSearch}
                        />
                        <button
                            onClick={() => setMobileFilterOpen(false)}
                            className="w-full flex items-center justify-center"
                            style={{
                                marginTop: "24px",
                                height: "48px",
                                background: "var(--color-primary)",
                                color: "var(--color-inverse)",
                                borderRadius: "9999px",
                                fontWeight: 700,
                                fontSize: "15px",
                            }}
                        >
                            Show {filteredProducts.length} Results
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    /* ============================================================
         DESKTOP / WEB LAYOUT — Pelago HTML design
      ============================================================ */
    return (
        <div
            style={{
                minHeight: "100vh",
                background: CANVAS,
                backgroundImage: "radial-gradient(rgba(20,40,35,0.02) 1px, transparent 0)",
                backgroundSize: "24px 24px",
                fontFamily: FONT,
                display: "flex",
                flexDirection: "column",
            }}
        >
            {/* ── Category pill bar (full-width, above everything) ── */}
            <div
                ref={chipsRef}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    overflowX: "auto",
                    padding: "16px 24px 0",
                    scrollbarWidth: "none",
                }}
            >
                {/* All */}
                <button
                    onClick={() => setActiveChip("all")}
                    className="cat-chip"
                    style={{
                        flexShrink: 0,
                        padding: "7px 16px",
                        borderRadius: "9999px",
                        fontSize: "12px",
                        fontWeight: 700,
                        border: "none",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        transition: "background 0.15s",
                        ...(activeChip === "all"
                            ? { background: CHARCOAL, color: WHITE, boxShadow: "0 1px 4px rgba(0,0,0,0.15)" }
                            : { background: WHITE, color: CHARCOAL, border: `1px solid ${BORDER}` }),
                    }}
                >
                    All Categories <span style={{ opacity: 0.7, fontWeight: 400 }}>{totalProductCount}</span>
                </button>
                {categories.filter(Boolean).map((cat) => (
                    <button
                        key={cat}
                        onClick={() => setActiveChip(cat === activeChip ? "all" : cat)}
                        className="cat-chip"
                        style={{
                            flexShrink: 0,
                            padding: "7px 14px",
                            borderRadius: "9999px",
                            fontSize: "12px",
                            fontWeight: 600,
                            border: "none",
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                            transition: "background 0.15s",
                            ...(activeChip === cat
                                ? { background: CHARCOAL, color: WHITE, boxShadow: "0 1px 4px rgba(0,0,0,0.15)" }
                                : { background: WHITE, color: CHARCOAL, border: `1px solid ${BORDER}` }),
                        }}
                    >
                        {toTitleCase(cat)}{" "}
                        <span style={{ color: MUTED, fontWeight: 400 }}>{categoryCounts[cat] || 0}</span>
                    </button>
                ))}
            </div>

            {/* ── Main layout: sidebar + content ── */}
            <div style={{ display: "flex", flex: 1, gap: "24px", padding: "16px 24px 32px", alignItems: "flex-start" }}>

                {/* ===================== LEFT FILTER SIDEBAR ===================== */}
                <aside
                    ref={sidebarRef}
                    className="hidden lg:flex"
                    style={{
                        flexDirection: "column",
                        flexShrink: 0,
                        width: "240px",
                        background: WHITE,
                        borderRadius: "24px",
                        border: `1px solid ${BORDER}`,
                        padding: "20px",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                        position: "sticky",
                        top: "88px",
                        maxHeight: "calc(100vh - 108px)",
                        overflowY: "auto",
                        gap: "0",
                        scrollbarWidth: "none",
                    }}
                >
                    {/* Header */}
                    <div style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        paddingBottom: "12px", borderBottom: `1px solid ${BORDER}`, marginBottom: "16px",
                    }}>
                        <h3 style={{ fontWeight: 700, fontSize: "14px", color: CHARCOAL }}>Categories &amp; Filter</h3>
                        <button
                            onClick={clearAllFilters}
                            style={{ fontSize: "12px", fontWeight: 600, color: TEAL, background: "none", border: "none", cursor: "pointer" }}
                        >
                            Reset all
                        </button>
                    </div>

                    {/* Search catalog */}
                    <div style={{ marginBottom: "20px" }}>
                        <SectionLabel>Search Catalog</SectionLabel>
                        <div style={{ position: "relative" }}>
                            <input
                                type="text"
                                value={filterSearch}
                                onChange={(e) => setFilterSearch(e.target.value)}
                                placeholder="Search products by name..."
                                style={{
                                    width: "100%", boxSizing: "border-box",
                                    padding: "8px 12px 8px 32px",
                                    borderRadius: "12px",
                                    border: `1px solid ${BORDER}`,
                                    fontSize: "12px", color: CHARCOAL,
                                    background: `${SAND}66`,
                                    outline: "none", fontFamily: FONT,
                                }}
                                onFocus={e => { e.target.style.background = WHITE; e.target.style.borderColor = TEAL; }}
                                onBlur={e => { e.target.style.background = `${SAND}66`; e.target.style.borderColor = BORDER; }}
                            />
                            <SearchIcon size={14} style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: MUTED, pointerEvents: "none" }} />
                        </div>
                    </div>

                    {/* Department */}
                    <div style={{ marginBottom: "20px" }}>
                        <SectionLabel>Department</SectionLabel>
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            {displayedDepartments.length ? (
                                displayedDepartments.map((cat) => (
                                    <CheckRow
                                        key={cat}
                                        checked={selectedDepartments.includes(cat)}
                                        onChange={() => toggleDepartment(cat)}
                                        count={categoryCounts[cat] || 0}
                                    >
                                        {toTitleCase(cat)}
                                    </CheckRow>
                                ))
                            ) : (
                                <p style={{ fontSize: "12px", color: MUTED }}>No departments</p>
                            )}
                        </div>
                    </div>

                    {/* Price Range */}
                    <div style={{ marginBottom: "20px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                            <SectionLabel>Price Range</SectionLabel>
                            <span style={{ fontSize: "11px", fontWeight: 700, color: CHARCOAL }}>
                                ₹{priceMin || 0} – ₹{priceMax || maxPriceValue}
                            </span>
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={5000}
                            value={priceMax === "" ? 5000 : Number(priceMax)}
                            onChange={(e) => setPriceMax(e.target.value)}
                            style={{ width: "100%", marginBottom: "8px", accentColor: TEAL, height: "6px", background: SAND, borderRadius: "4px", cursor: "pointer" }}
                        />
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <input
                                type="number"
                                value={priceMin}
                                onChange={(e) => setPriceMin(e.target.value)}
                                placeholder="Min"
                                style={{
                                    width: "50%", padding: "6px 8px", borderRadius: "10px",
                                    border: `1px solid ${BORDER}`, fontSize: "12px", color: CHARCOAL,
                                    background: `${SAND}55`, outline: "none", fontFamily: FONT,
                                }}
                            />
                            <span style={{ fontSize: "11px", color: MUTED }}>—</span>
                            <input
                                type="number"
                                value={priceMax}
                                onChange={(e) => setPriceMax(e.target.value)}
                                placeholder="Max"
                                style={{
                                    width: "50%", padding: "6px 8px", borderRadius: "10px",
                                    border: `1px solid ${BORDER}`, fontSize: "12px", color: CHARCOAL,
                                    background: `${SAND}55`, outline: "none", fontFamily: FONT,
                                }}
                            />
                        </div>
                    </div>

                    {/* Customer Rating */}
                    <div style={{ marginBottom: "20px" }}>
                        <SectionLabel>Customer Rating</SectionLabel>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            {[4, 3].map((t) => (
                                <CheckRow
                                    key={t}
                                    checked={ratingThresholds.includes(t)}
                                    onChange={() => toggleRating(t)}
                                >
                                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                        <span style={{ color: "#F59E0B", fontWeight: 700 }}>{"★".repeat(t)}{"☆".repeat(5 - t)}</span>
                                        <span style={{ fontSize: "11px" }}>{t}★ &amp; Above</span>
                                    </span>
                                </CheckRow>
                            ))}
                        </div>
                    </div>

                    {/* Availability */}
                    <div style={{ marginBottom: "20px" }}>
                        <SectionLabel>Availability</SectionLabel>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <CheckRow checked={availability.includes("inStock")} onChange={() => toggleAvailability("inStock")}>
                                In Stock
                            </CheckRow>
                            <CheckRow checked={availability.includes("lowStock")} onChange={() => toggleAvailability("lowStock")}>
                                Low Stock
                            </CheckRow>
                        </div>
                    </div>

                    {/* Apply button */}
                    <button
                        onClick={applyFilters}
                        style={{
                            width: "100%", padding: "10px", borderRadius: "12px",
                            background: TEAL, color: WHITE, border: "none",
                            fontSize: "12px", fontWeight: 700, cursor: "pointer",
                            fontFamily: FONT, marginTop: "4px", transition: "background 0.15s",
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = TEAL_DARK}
                        onMouseLeave={e => e.currentTarget.style.background = TEAL}
                    >
                        Apply Filters
                    </button>
                </aside>

                {/* ===================== MAIN CONTENT ===================== */}
                <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "24px" }}>

                    {/* Page header */}
                    <header style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <span style={{ fontSize: "12px", fontWeight: 600, color: MUTED }}>
                            Discover Everything &amp; Catalog
                        </span>
                        <h2 style={{ fontSize: "28px", fontWeight: 800, color: CHARCOAL, letterSpacing: "-0.5px", margin: 0 }}>
                            Discover Everything
                        </h2>
                    </header>

                    {/* Sort + count bar */}
                    <div style={{
                        background: WHITE,
                        borderRadius: "16px",
                        border: `1px solid ${BORDER}`,
                        padding: "12px 14px",
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "12px",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                    }}>
                        {/* Left: search */}
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: "200px" }}>
                            <div style={{ position: "relative", flex: 1, maxWidth: "340px" }}>
                                <SearchIcon size={15} style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: MUTED, pointerEvents: "none" }} />
                                <input
                                    type="text"
                                    value={deskSearch}
                                    onChange={(e) => setDeskSearch(e.target.value)}
                                    onFocus={() => setActiveSearchField("desktop")}
                                    onBlur={() => setActiveSearchField(null)}
                                    onKeyDown={(e) => e.key === "Enter" && commitSearch(deskSearch)}
                                    placeholder="Search products by name..."
                                    style={{
                                        width: "100%", boxSizing: "border-box",
                                        padding: "8px 12px 8px 34px",
                                        borderRadius: "12px",
                                        border: `1px solid ${BORDER}`,
                                        fontSize: "12px", color: CHARCOAL,
                                        background: `${SAND}44`,
                                        outline: "none", fontFamily: FONT,
                                    }}
                                    onFocusCapture={e => { e.target.style.background = WHITE; e.target.style.borderColor = TEAL; }}
                                    onBlurCapture={e => { e.target.style.background = `${SAND}44`; e.target.style.borderColor = BORDER; }}
                                />
                                {activeSearchField === "desktop" && (
                                    <SearchSuggestions query={deskSearch} {...suggestionProps} />
                                )}
                            </div>
                            <span style={{ fontSize: "12px", fontWeight: 600, color: MUTED, whiteSpace: "nowrap" }}>Showing:</span>
                            <span style={{ fontSize: "12px", fontWeight: 700, color: CHARCOAL, whiteSpace: "nowrap" }}>
                                {desktopFiltered.length} products in catalog
                            </span>
                        </div>
                        {/* Right: sort */}
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <span style={{ fontSize: "12px", color: MUTED }}>Sort by:</span>
                            <select
                                value={deskSort}
                                onChange={(e) => setDeskSort(e.target.value)}
                                style={{
                                    padding: "6px 28px 6px 10px",
                                    borderRadius: "12px",
                                    border: `1px solid ${BORDER}`,
                                    fontSize: "12px", fontWeight: 500, color: CHARCOAL,
                                    background: `${SAND}33`,
                                    outline: "none", cursor: "pointer", fontFamily: FONT,
                                }}
                            >
                                {SORT_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Recently viewed */}
                    {!loading && recentlyViewedProducts.length > 0 && (
                        <div>
                            <div style={{
                                display: "flex", alignItems: "center", justifyContent: "space-between",
                                paddingBottom: "12px", marginBottom: "16px",
                                borderBottom: `1px solid ${BORDER}`,
                            }}>
                                <h2 style={{ fontWeight: 700, fontSize: "18px", color: CHARCOAL, margin: 0 }}>
                                    Recently Viewed
                                </h2>
                            </div>
                            <div style={{ display: "flex", gap: "16px", overflowX: "auto", scrollbarWidth: "none" }}>
                                {recentlyViewedProducts.map((product) => (
                                    <div key={product.id} style={{ width: "200px", flexShrink: 0 }}>
                                        <NewProductCard
                                            product={product}
                                            onAddToCart={handleAddToCart}
                                            onDecrement={handleDecrement}
                                            onToggleWishlist={handleToggleWishlist}
                                            isWishlisted={isWishlisted(product.id)}
                                            quantity={cartQty(product.id)}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Product sections */}
                    <div ref={gridRef}>
                        {loading ? (
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px" }} aria-busy="true">
                                {[...Array(8)].map((_, i) => (
                                    <NewProductCardSkeleton key={i} />
                                ))}
                            </div>
                        ) : Object.keys(desktopGrouped).length === 0 ? (
                            <div style={{ minHeight: "40vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "16px" }}>
                                <p style={{ color: MUTED, fontSize: "14px" }}>No products match your filters.</p>
                                <button
                                    onClick={clearAllFilters}
                                    style={{ color: TEAL, fontWeight: 700, fontSize: "13px", background: "none", border: "none", cursor: "pointer" }}
                                >
                                    Clear all filters
                                </button>
                            </div>
                        ) : (
                            Object.keys(desktopGrouped).map((category, idx) => {
                                // Cycle through dot colours matching the HTML design
                                const dotColors = [TEAL, "#EF4444", "#D97706", "#6366F1", "#10B981", "#F59E0B", "#8B5CF6"];
                                const dotColor = dotColors[idx % dotColors.length];
                                return (
                                    <section key={category} style={{ marginBottom: "40px" }}>
                                        {/* Section header */}
                                        <div style={{
                                            display: "flex", alignItems: "center",
                                            justifyContent: "space-between", marginBottom: "16px",
                                        }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                                <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
                                                <h3 style={{ fontSize: "18px", fontWeight: 700, color: CHARCOAL, margin: 0 }}>
                                                    {toTitleCase(category)}
                                                </h3>
                                                <span style={{
                                                    fontSize: "11px", color: MUTED, fontWeight: 500,
                                                    background: WHITE, padding: "2px 8px",
                                                    borderRadius: "6px", border: `1px solid ${BORDER}`,
                                                }}>
                                                    {categoryCounts[category] || desktopGrouped[category].length} Products
                                                </span>
                                            </div>
                                            <button
                                                onClick={() => setActiveChip(category)}
                                                style={{
                                                    display: "flex", alignItems: "center", gap: "4px",
                                                    fontSize: "12px", fontWeight: 700, color: TEAL,
                                                    background: "none", border: "none", cursor: "pointer",
                                                    textDecoration: "none",
                                                }}
                                            >
                                                View All <span aria-hidden="true">→</span>
                                            </button>
                                        </div>

                                        {/* Product grid */}
                                        <div style={{
                                            display: "grid",
                                            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                                            gap: "16px",
                                        }}>
                                            {desktopGrouped[category].map((product) => (
                                                <NewProductCard
                                                    key={product.id}
                                                    product={product}
                                                    onAddToCart={handleAddToCart}
                                                    onDecrement={handleDecrement}
                                                    onToggleWishlist={handleToggleWishlist}
                                                    isWishlisted={isWishlisted(product.id)}
                                                    quantity={cartQty(product.id)}
                                                />
                                            ))}
                                        </div>
                                    </section>
                                );
                            })
                        )}
                    </div>
                </main>
            </div>
        </div>
    );
};

export default memo(ProductsPage);
