/**
 * supabaseStorage.js
 *
 * Centralised helpers for Supabase Storage (products bucket).
 * All image uploads / deletions / URL helpers should go through here so that
 * the bucket name and CDN base-URL live in exactly one place.
 *
 * AddProductPage, EditProductPage, and VariantManager all already upload to
 * supabase.storage.from("products") — this file just gives them a shared utility
 * and adds the optional Supabase Image Transform helper for resized thumbnails.
 */

import { supabase } from "../context/SupabaseConfig"

// ─── Constants ───────────────────────────────────────────────────────────────

export const PRODUCTS_BUCKET = "products"

// Derived from your Supabase project URL in SupabaseConfig.js
const SUPABASE_BASE =
  "https://hexosjsftzdqmwqbeahy.supabase.co/storage/v1/object/public"

// ─── Upload ──────────────────────────────────────────────────────────────────

/**
 * Upload a File to the `products` bucket.
 *
 * @param {string} path   Storage path, e.g. `prod_123/thumbnail/main.jpg`
 * @param {File}   file   Browser File object
 * @returns {Promise<string>} Public CDN URL
 */
export async function uploadProductImage(path, file) {
  const { error } = await supabase.storage
    .from(PRODUCTS_BUCKET)
    .upload(path, file, { upsert: true })
  if (error) throw error
  return supabase.storage.from(PRODUCTS_BUCKET).getPublicUrl(path).data
    .publicUrl
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a file from the `products` bucket using its full public URL.
 * Silently skips URLs that don't belong to this bucket (external images, etc.).
 *
 * @param {string} publicUrl  The full Supabase Storage public URL
 * @returns {Promise<void>}
 */
export async function deleteProductImage(publicUrl) {
  if (!publicUrl) return
  const marker = `/storage/v1/object/public/${PRODUCTS_BUCKET}/`
  const idx = publicUrl.indexOf(marker)
  if (idx === -1) return // not a storage URL — skip silently
  const storagePath = publicUrl.slice(idx + marker.length)
  await supabase.storage.from(PRODUCTS_BUCKET).remove([storagePath])
}

/**
 * Delete multiple files from the `products` bucket.
 * Filters out any URLs that aren't Supabase Storage URLs.
 *
 * @param {string[]} publicUrls
 * @returns {Promise<void>}
 */
export async function deleteProductImages(publicUrls) {
  if (!publicUrls?.length) return
  const marker = `/storage/v1/object/public/${PRODUCTS_BUCKET}/`
  const paths = publicUrls
    .filter((u) => u && u.includes(marker))
    .map((u) => u.slice(u.indexOf(marker) + marker.length))
  if (paths.length) {
    await supabase.storage.from(PRODUCTS_BUCKET).remove(paths)
  }
}

// ─── URL Helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if `url` is a Supabase Storage URL for the products bucket.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isSupabaseStorageUrl(url) {
  return Boolean(url && url.includes(SUPABASE_BASE))
}

/**
 * Append Supabase Image Transform query params to a Storage URL for
 * on-the-fly resizing. Falls back to the original URL if:
 *   - the URL is not a Supabase Storage URL (external image)
 *   - no options are provided
 *
 * ⚠️  Supabase Image Transforms require the Storage plan that supports them.
 *     If your project is on the free tier without transforms enabled, the
 *     render URL will still work but won't resize — it just returns the
 *     original image. This is safe as a progressive enhancement.
 *
 * @param {string} publicUrl          Full Supabase Storage public URL
 * @param {{ width?: number, height?: number, quality?: number, format?: string }} opts
 * @returns {string}  Transformed URL (or original URL as a safe fallback)
 *
 * @example
 *   getResizedUrl(product.thumbnail, { width: 400, quality: 80 })
 *   // → https://...supabase.co/storage/v1/render/image/public/products/...?width=400&quality=80
 */
export function getResizedUrl(publicUrl, opts = {}) {
  if (!publicUrl || !isSupabaseStorageUrl(publicUrl)) return publicUrl ?? ""
  if (!opts.width && !opts.height && !opts.quality && !opts.format) {
    return publicUrl
  }

  // Replace /object/public/ with /render/image/public/ for image transforms
  const renderUrl = publicUrl.replace(
    "/storage/v1/object/public/",
    "/storage/v1/render/image/public/"
  )

  const params = new URLSearchParams()
  if (opts.width) params.set("width", String(opts.width))
  if (opts.height) params.set("height", String(opts.height))
  if (opts.quality) params.set("quality", String(opts.quality))
  if (opts.format) params.set("format", opts.format)

  return `${renderUrl}?${params.toString()}`
}

// ─── Path Builders ────────────────────────────────────────────────────────────

/**
 * Build the storage path for a product thumbnail.
 * @param {string} productId
 * @param {string} filename
 * @returns {string}
 */
export function thumbnailPath(productId, filename) {
  return `${productId}/thumbnail/${filename}`
}

/**
 * Build the storage path for a product gallery image.
 * @param {string} productId
 * @param {string} filename
 * @returns {string}
 */
export function galleryImagePath(productId, filename) {
  return `${productId}/gallery/${filename}`
}

/**
 * Build the storage path for a variant image.
 * @param {string} productId
 * @param {string} variantId
 * @param {string} filename
 * @returns {string}
 */
export function variantImagePath(productId, variantId, filename) {
  return `${productId}/variants/${variantId}/${filename}`
}

