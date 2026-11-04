-- ============================================================================
-- M9 — CUSTOMER REPLIES ON AN OPEN RETURN / EXCHANGE REQUEST (requires M4/M5, i.e. 20261017_04 and 20261017_05).
--
-- respond_to_request() is a single-purpose answer to "we need more information" (needs_info -> pending_review). It gives the
-- customer no way to write back while the request is in any OTHER open state (awaiting_return_shipment, return_in_transit,
-- inspection_pending, refund_pending, ...) - until now she could only READ the admin's messages there (return_request_events,
-- already rendered as the "History" timeline on both the admin and customer screens).
--
-- customer_message_request(p_request_id, p_message) fixes that: it inserts a customer-authored, non-internal event - the existing
-- History timeline on both sides picks it up with no further change - and notifies the admins. It NEVER touches
-- return_requests.status or customer_note; only respond_to_request (the needs_info answer) and send_request_message (the admin's
-- message) do that. Blocked once the request has reached a FINAL status (rejected / closed / cancelled), the same list
-- app_apply_request_transition already treats as final.
--
-- HOW TO RUN: SQL Editor -> paste -> Run. SAFE TO RE-RUN. Rollback: 20261102_01_rollback.sql.
-- ROLL-OUT ORDER: SQL first, then the website / app change that calls it (src/features/returns).
-- ============================================================================
begin;

create or replace function public.customer_message_request(p_request_id uuid, p_message text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  r     public.return_requests;
  v_msg text := nullif(btrim(coalesce(p_message, '')), '');
begin
  if v_uid is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  select * into r from public.return_requests where id = p_request_id;
  if not found or r.user_id is distinct from v_uid then raise exception 'Request not found' using errcode = 'P0002'; end if;
  if r.status in ('rejected', 'closed', 'cancelled') then raise exception 'This request is closed - start a new one instead' using errcode = '22023'; end if;
  if v_msg is null then raise exception 'Write a message' using errcode = '22023'; end if;
  if char_length(v_msg) > 1000 then raise exception 'The message is too long (1000 characters at most)' using errcode = '22023'; end if;
  insert into public.return_request_events (request_id, actor_id, actor_role, note) values (p_request_id, v_uid, 'customer', v_msg);
  perform public.app_notify_admins('Customer message', r.request_no || ' · ' || v_msg,
    jsonb_build_object('type', 'admin_request', 'requestId', r.id, 'requestNo', r.request_no, 'orderId', r.order_id));
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.customer_message_request(uuid, text) from public, anon;
grant execute on function public.customer_message_request(uuid, text) to authenticated;     -- the owner check is inside

commit;

notify pgrst, 'reload schema';