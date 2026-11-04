-- ============================================================================
-- M9 ROLLBACK — removes customer_message_request() (20261102_01_customer_request_message.sql). Data (any event rows it already
-- inserted) is never touched - only the function and its grants go.
-- SAFE TO RE-RUN. Independent of every other rollback.
-- ============================================================================
begin;

drop function if exists public.customer_message_request(uuid, text);

commit;

notify pgrst, 'reload schema';