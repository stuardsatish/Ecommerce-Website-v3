-- ============================================================================
-- M10 ROLLBACK — removes billing_contacts entirely (20261102_02_customer_categories.sql) and profiles.channel. Run this BEFORE
-- re-running the forward migration if you need to change the column/table shape; it drops real data (billing_contacts rows and
-- the channel tag on every profile) so take a backup first if any has been entered.
-- SAFE TO RE-RUN. Independent of every other rollback.
-- ============================================================================
begin;

drop trigger if exists billing_contacts_touch on public.billing_contacts;
drop table if exists public.billing_contacts;

alter table public.profiles drop constraint if exists profiles_channel_chk;
alter table public.profiles drop column if exists channel;

commit;

notify pgrst, 'reload schema';