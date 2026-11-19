-- ============================================================================
-- FIX: Bulk re-import after deleting products shows "already imported"
--
-- ROOT CAUSE:
--   import_stage_batch() checks for a live import_batches row (status IN
--   ('staged','committed')) that matches (created_by, file_hash).  When a
--   'committed' batch is found it returns { already:true } immediately —
--   WITHOUT checking whether the products from that batch still exist in the
--   products table.  Deleting the products leaves the batch row in place, so
--   re-uploading the identical files always hits the stale batch and the admin
--   sees "These files were already imported — nothing was repeated."
--
-- FIX:
--   When a 'committed' batch is found during staging, check whether any of its
--   product import_keys are still present in the products table.
--   • If NONE exist (all deleted) → cancel / mark that old batch as 'cancelled'
--     so its unique-index slot is freed, then fall through to run a fresh stage.
--   • If AT LEAST ONE still exists → the import genuinely already ran and
--     some products are still live; return { already:true } as before.
--
-- HOW TO RUN: SQL Editor → paste → Run.  Safe to re-run.
-- ============================================================================
begin;

create or replace function public.import_stage_batch(p_file_hash text, p_file_name text, p_groups jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_catalog
as $$
declare
  c_group_keys constant text[] := array['import_key', 'row', 'kind', 'product', 'variants', 'images', 'hasErrors'];
  c_variant_keys constant text[] := array['import_key', 'row', 'name', 'sku', 'price', 'stock', 'track_inventory', 'status', 'sort_order',
                                          'attributes', 'return_enabled', 'return_window_days', 'exchange_enabled', 'exchange_window_days', 'images'];
  v_uid       uuid := auth.uid();
  v_batch     public.import_batches;
  v_g         record;
  v_v         record;
  v_k         text;
  v_key       text;
  v_row       int;
  v_hash      text;
  v_existing  public.products;
  v_pid       text;
  v_vid       text;
  v_product   jsonb;
  v_variants  jsonb;
  v_vjson     jsonb;
  v_defaults  jsonb;
  v_images    jsonb;
  v_main      text;
  v_gallery   jsonb;
  v_vimages   jsonb;
  v_errors    jsonb := '[]'::jsonb;
  v_results   jsonb := '[]'::jsonb;
  v_new       jsonb := '[]'::jsonb;
  v_paths     text[] := '{}';
  v_seen      text[] := '{}';
  v_bad       boolean;
  v_n_new     int := 0;
  v_n_unch    int := 0;
  v_n_var     int := 0;
  v_ref       text;
  v_vmeta     jsonb;
  -- FIX: used for the stale-batch check
  v_any_still_live boolean;
begin
  if v_uid is null or not public.app_is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_file_hash is null or p_file_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'file hash must be a SHA-256 hex string' using errcode = '22023';
  end if;
  if p_groups is null or jsonb_typeof(p_groups) <> 'array' or jsonb_array_length(p_groups) = 0 then
    raise exception 'The import has no products' using errcode = '22023';
  end if;
  if jsonb_array_length(p_groups) > 1000 then
    raise exception 'An import may hold at most 1000 products (found %)', jsonb_array_length(p_groups) using errcode = '54000';
  end if;

  -- ── idempotency: the same file from the same admin returns the live batch ────────────────────
  select * into v_batch
    from public.import_batches
   where created_by = v_uid
     and file_hash  = p_file_hash
     and status in ('staged', 'committed');

  if found then
    -- ── FIX: for a *committed* batch, verify that the products still exist. ─────────────────────
    -- A 'staged' (not yet committed) batch is always legitimate to re-attach to.
    -- A 'committed' batch whose products have since been deleted must NOT block re-import.
    if v_batch.status = 'committed' then
      -- Check whether at least one of the imported product import_keys is still alive.
      -- The batch payload stores the groups array; each element has an 'import_key' field.
      select exists (
        select 1
          from jsonb_array_elements(v_batch.payload -> 'groups') as g(elem)
          join public.products p
            on lower(p.import_key) = lower(g.elem ->> 'import_key')
      ) into v_any_still_live;

      if not v_any_still_live then
        -- All products from this batch were deleted.
        -- Cancel the stale batch so its (created_by, file_hash) unique-index slot is freed,
        -- then fall through to run a fresh stage as if this were a first import.
        update public.import_batches
           set status     = 'cancelled',
               updated_at = now()
         where id = v_batch.id;

        -- Clear v_batch so the rest of the function behaves as a first-time import.
        v_batch := null;
        -- (fall through to the main staging logic below)
      else
        -- At least one product still exists: the import genuinely already ran.
        return jsonb_build_object(
          'ok', true, 'already', true,
          'batch_id', v_batch.id, 'status', v_batch.status,
          'image_paths', to_jsonb(v_batch.image_paths),
          'summary', v_batch.summary,
          'report', v_batch.report
        );
      end if;
    else
      -- 'staged' batch: return it as-is (normal idempotency / retry path).
      return jsonb_build_object(
        'ok', true, 'already', true,
        'batch_id', v_batch.id, 'status', v_batch.status,
        'image_paths', to_jsonb(v_batch.image_paths),
        'summary', v_batch.summary,
        'report', v_batch.report
      );
    end if;
  end if;
  -- ─────────────────────────────────────────────────────────────────────────────────────────────

  -- everything between here and the sentinel is a DRY RUN: it is rolled back, only the local variables survive
  begin
    for v_g in select e.elem, e.ord from jsonb_array_elements(p_groups) with ordinality as e(elem, ord) order by e.ord loop
      v_bad := false;
      v_row := case when (v_g.elem ->> 'row') ~ '^\d{1,9}$' then (v_g.elem ->> 'row')::int else 0 end;
      v_key := btrim(coalesce(v_g.elem ->> 'import_key', ''));

      -- ---- structure -------------------------------------------------------------------------------------------------
      if jsonb_typeof(v_g.elem) <> 'object' then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'E200', 'row', 0, 'import_key', '', 'message', format('Item %s of the plan is not an object', v_g.ord)));
        continue;
      end if;
      for v_k in select jsonb_object_keys(v_g.elem) loop
        if v_k <> all (c_group_keys) then
          v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'E200', 'row', v_row, 'import_key', v_key, 'message', format('Unknown field "%s" in the plan', v_k)));
          v_bad := true;
        end if;
      end loop;
      if v_key !~ '^[A-Za-z0-9._-]{1,64}$' or v_key ~* '_var_' then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'E003', 'row', v_row, 'import_key', v_key, 'message', format('Import ID "%s" is invalid', v_key)));
        continue;
      end if;
      if lower(v_key) = any (v_seen) then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'E002', 'row', v_row, 'import_key', v_key, 'message', format('Import ID "%s" appears more than once', v_key)));
        continue;
      end if;
      v_seen := v_seen || lower(v_key);
      if v_bad or jsonb_typeof(v_g.elem -> 'product') <> 'object' or jsonb_typeof(coalesce(v_g.elem -> 'variants', '[]'::jsonb)) <> 'array' then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'E200', 'row', v_row, 'import_key', v_key, 'message', 'Malformed product in the plan'));
        continue;
      end if;
      if jsonb_array_length(coalesce(v_g.elem -> 'variants', '[]'::jsonb)) > 200 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'E200', 'row', v_row, 'import_key', v_key, 'message', 'A product may have at most 200 variants in one import'));
        continue;
      end if;

      -- ---- image references ----------------------------------------------------------------------------------------
      v_images := coalesce(v_g.elem -> 'images', '{}'::jsonb);
      begin
        perform public.app_import_check_ref(v_images ->> 'main', 'Main image');
        if jsonb_typeof(coalesce(v_images -> 'gallery', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(v_images -> 'gallery', '[]'::jsonb)) > 8 then
          raise exception 'Additional images must be a list of at most 8 file names' using errcode = '22023';
        end if;
        for v_ref in select jsonb_array_elements_text(coalesce(v_images -> 'gallery', '[]'::jsonb)) loop
          perform public.app_import_check_ref(v_ref, 'Additional image');
        end loop;
        for v_v in select e.elem from jsonb_array_elements(coalesce(v_g.elem -> 'variants', '[]'::jsonb)) as e(elem) loop
          if jsonb_typeof(v_v.elem) <> 'object' then raise exception 'Each variant must be an object' using errcode = '22023'; end if;
          for v_k in select jsonb_object_keys(v_v.elem) loop
            if v_k <> all (c_variant_keys) then raise exception 'Unknown variant field "%"', v_k using errcode = '22023'; end if;
          end loop;
          if coalesce(v_v.elem ->> 'import_key', '') !~ '^[A-Za-z0-9._-]{1,64}$' or (v_v.elem ->> 'import_key') ~* '_var_' then
            raise exception 'Variant Import ID "%" is invalid', coalesce(v_v.elem ->> 'import_key', '') using errcode = '22023';
          end if;
          -- group keys and variant keys share one namespace (a variant may not reuse its parent's or another product's key)
          if lower(v_v.elem ->> 'import_key') = any (v_seen) then
            raise exception 'Import ID "%" appears more than once', v_v.elem ->> 'import_key' using errcode = '22023';
          end if;
          v_seen := v_seen || lower(v_v.elem ->> 'import_key');
          perform public.app_import_check_ref(v_v.elem -> 'images' ->> 'main', 'Variant image');
          for v_ref in select jsonb_array_elements_text(coalesce(v_v.elem -> 'images' -> 'gallery', '[]'::jsonb)) loop
            perform public.app_import_check_ref(v_ref, 'Variant additional image');
          end loop;
        end loop;
      exception when others then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'E200', 'row', v_row, 'import_key', v_key, 'message', sqlerrm));
        continue;
      end;

      -- ---- already imported? (create-only) ---------------------------------------------------------------------------
      v_hash := public.app_import_group_hash(v_g.elem);
      select * into v_existing from public.products where lower(import_key) = lower(v_key);
      if found then
        if v_existing.import_hash is not distinct from v_hash then
          v_results := v_results || jsonb_build_array(jsonb_build_object('import_key', v_key, 'row', v_row, 'status', 'unchanged', 'product_id', v_existing.id));
          v_n_unch := v_n_unch + 1;
        else
          v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'E070', 'row', v_row, 'import_key', v_key,
            'message', format('"%s" already exists (product %s) with different content. The importer never overwrites — change the Import ID, or edit the product in the admin.', v_key, v_existing.id)));
        end if;
        continue;
      end if;
      if exists (select 1 from public.product_variants pv where lower(pv.import_key) in
                  (select lower(e.elem ->> 'import_key') from jsonb_array_elements(coalesce(v_g.elem -> 'variants', '[]'::jsonb)) as e(elem))) then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', 'E070', 'row', v_row, 'import_key', v_key,
          'message', 'One of this product''s variant Import IDs is already used by another product.'));
        continue;
      end if;

      -- ---- ids, final paths, policy defaults -----------------------------------------------------------------------
      v_pid := 'prod_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 14);
      v_product := (v_g.elem -> 'product') || jsonb_build_object('id', v_pid, 'import_key', v_key);
      v_defaults := public.app_import_policy_defaults(v_product ->> 'category');
      if not (v_product ? 'return_enabled') then
        v_product := v_product || jsonb_build_object('return_enabled', v_defaults -> 'return_enabled', 'return_window_days', v_defaults -> 'return_window_days');
      end if;
      if not (v_product ? 'exchange_enabled') then
        v_product := v_product || jsonb_build_object('exchange_enabled', v_defaults -> 'exchange_enabled', 'exchange_window_days', v_defaults -> 'exchange_window_days');
      end if;

      v_main := public.app_import_image_ref(v_images ->> 'main', v_pid, 'thumbnail');
      v_gallery := coalesce((select jsonb_agg(public.app_import_image_ref(g, v_pid, 'gallery') order by o)
                              from jsonb_array_elements_text(coalesce(v_images -> 'gallery', '[]'::jsonb)) with ordinality as t(g, o)), '[]'::jsonb);
      if v_main !~* '^https?://' then v_paths := v_paths || v_main; end if;
      for v_ref in select jsonb_array_elements_text(v_gallery) loop
        if v_ref !~* '^https?://' then v_paths := v_paths || v_ref; end if;
      end loop;

      v_variants := '[]'::jsonb;
      v_vimages := '{}'::jsonb;
      v_vmeta := '[]'::jsonb;
      for v_v in select e.elem, e.ord from jsonb_array_elements(coalesce(v_g.elem -> 'variants', '[]'::jsonb)) with ordinality as e(elem, ord) order by e.ord loop
        v_vid := public.app_new_variant_id();
        v_vjson := (v_v.elem - 'row' - 'images') || jsonb_build_object('id', v_vid);
        v_variants := v_variants || jsonb_build_array(v_vjson);
        v_vmeta := v_vmeta || jsonb_build_array(jsonb_build_object('id', v_vid, 'import_key', v_v.elem ->> 'import_key',
          'row', case when (v_v.elem ->> 'row') ~ '^\d{1,9}$' then (v_v.elem ->> 'row')::int else 0 end));
        v_main := public.app_import_image_ref(v_v.elem -> 'images' ->> 'main', v_pid || '/variants', v_vid);
        v_vimages := v_vimages || jsonb_build_object(v_vid, jsonb_build_object(
          'main', v_main,
          'gallery', coalesce((select jsonb_agg(public.app_import_image_ref(g, v_pid || '/variants', v_vid) order by o)
                                from jsonb_array_elements_text(coalesce(v_v.elem -> 'images' -> 'gallery', '[]'::jsonb)) with ordinality as t(g, o)), '[]'::jsonb)));
        if v_main is not null and v_main !~* '^https?://' then v_paths := v_paths || v_main; end if;
        for v_ref in select jsonb_array_elements_text(v_vimages -> v_vid -> 'gallery') loop
          if v_ref !~* '^https?://' then v_paths := v_paths || v_ref; end if;
        end loop;
        v_n_var := v_n_var + 1;
      end loop;
      v_main := public.app_import_image_ref(v_images ->> 'main', v_pid, 'thumbnail');

      -- ---- the DRY RUN: the real write path, rolled back below ------------------------------------------------------
      begin
        perform public.save_product(v_product, v_variants, null, true);
      exception when others then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'code', case when sqlerrm ilike '%sku%' then 'E024' when sqlstate = '23505' then 'E070' else 'E201' end,
          'row', v_row, 'import_key', v_key, 'message', sqlerrm, 'sqlstate', sqlstate));
        continue;
      end;

      v_new := v_new || jsonb_build_array(jsonb_build_object(
        'import_key', v_key, 'row', v_row, 'hash', v_hash, 'product_id', v_pid, 'product', v_product, 'variants', v_variants,
        'images', jsonb_build_object('main', v_main, 'gallery', v_gallery), 'variant_images', v_vimages, 'variant_meta', v_vmeta));
      v_results := v_results || jsonb_build_array(jsonb_build_object('import_key', v_key, 'row', v_row, 'status', 'new', 'product_id', v_pid,
                                                                      'variants', jsonb_array_length(v_variants)));
      v_n_new := v_n_new + 1;
    end loop;

    raise exception 'import dry run finished' using errcode = 'P0099';     -- undoes every write above
  exception when sqlstate 'P0099' then
    null;
  end;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'errors', v_errors, 'groups', v_results);
  end if;
  if v_n_new = 0 then
    return jsonb_build_object('ok', true, 'status', 'unchanged', 'message', 'Everything in this file has already been imported unchanged — nothing to do.',
                              'groups', v_results, 'summary', jsonb_build_object('products', 0, 'unchanged', v_n_unch));
  end if;

  begin
    insert into public.import_batches (file_hash, file_name, created_by, summary, payload, image_paths)
    values (p_file_hash, left(p_file_name, 255), v_uid,
            jsonb_build_object('products', v_n_new, 'variants', v_n_var, 'unchanged', v_n_unch, 'images', coalesce(array_length(v_paths, 1), 0)),
            jsonb_build_object('groups', v_new), (select coalesce(array_agg(distinct p order by p), '{}') from unnest(v_paths) as p))
    returning * into v_batch;
  exception when unique_violation then
    -- a concurrent request staged the same file first: that batch is the answer
    select * into v_batch from public.import_batches where created_by = v_uid and file_hash = p_file_hash and status in ('staged', 'committed');
    return jsonb_build_object('ok', true, 'already', true, 'batch_id', v_batch.id, 'status', v_batch.status,
                              'image_paths', to_jsonb(v_batch.image_paths), 'summary', v_batch.summary, 'report', v_batch.report);
  end;

  return jsonb_build_object('ok', true, 'already', false, 'batch_id', v_batch.id, 'status', 'staged', 'groups', v_results,
                            'image_paths', to_jsonb(v_batch.image_paths), 'summary', v_batch.summary);
end;
$$;

-- Re-grant execute (security definer functions need this re-applied after replace)
revoke all on function public.import_stage_batch(text, text, jsonb) from public, anon;
grant execute on function public.import_stage_batch(text, text, jsonb) to authenticated;

commit;

notify pgrst, 'reload schema';
