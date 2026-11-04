-- ============================================================================
-- M10 — CUSTOMER CATEGORIES + SAVED BILLING CONTACTS, for the new "Manual Billing" admin page (friends / retailers / wholesale
-- buyers at a manually-set price, as opposed to /admin/billing which is the catalog-priced walk-in counter).
--
-- 1. profiles.channel BECOMES A REAL COLUMN. The admin UI (CustomersHubPage.jsx / CustomerAnalyticsPage.jsx) already reads and
--    writes `profiles.channel` ("Retail" / "Wholesale") and its "Add Customer" modal already inserts it - but the column never
--    existed in this schema, so every read silently fell back to a ₹25,000-spend guess and the insert would have failed outright.
--    Added here as a real, constrained column with the same two values plus the two new categories, default 'Retail' (today's
--    implicit behaviour) so every existing row is backfilled automatically. This only RE-TAGS an existing registered customer -
--    `profiles.id` is a hard FK to auth.users, so a customer who never signed up has no profile row to tag (see #2).
--
-- 2. billing_contacts is new: a lightweight saved-contact list for friends / retailers / wholesale buyers who do NOT have a
--    storefront account (most of them won't) - exactly what Manual Billing needs to "save contacts and fetch customers from a
--    category easily". `linked_user_id` is an optional pointer to a real profiles row, for the case where a saved contact later
--    turns out to also be a registered customer. Admin-only (back-office data, never exposed to the storefront RLS-wise).
--
-- HOW TO RUN: SQL Editor -> paste -> Run. SAFE TO RE-RUN. Rollback: 20261102_02_rollback.sql.
-- ROLL-OUT ORDER: SQL first, then the website change that uses it (src/pages/BillingPage, src/pages/UsersPage).
-- ============================================================================
begin;

-- 1 -- profiles.channel -------------------------------------------------------------------------------------------------------
alter table public.profiles add column if not exists channel text not null default 'Retail';
alter table public.profiles drop constraint if exists profiles_channel_chk;
alter table public.profiles add constraint profiles_channel_chk check (channel in ('Retail', 'Friends', 'Retailer', 'Wholesale'));

-- 2 -- billing_contacts --------------------------------------------------------------------------------------------------------
create table if not exists public.billing_contacts (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(btrim(name)) between 1 and 200),
  phone          text check (phone is null or char_length(phone) <= 30),
  email          text check (email is null or char_length(email) <= 200),
  category       text not null check (category in ('friends', 'retailer', 'wholesale')),
  address        jsonb,
  notes          text check (notes is null or char_length(notes) <= 2000),
  linked_user_id uuid references public.profiles (id) on delete set null,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists billing_contacts_category_idx on public.billing_contacts (category, name);
-- plain (not partial) so a bare `upsert(row, { onConflict: 'phone' })` from the client matches it; multiple NULL phones are
-- already allowed by a normal unique index, and the app always sends null (never '') for "no phone" - see orders-manual-billing-create.
create unique index if not exists billing_contacts_phone_idx on public.billing_contacts (phone);

alter table public.billing_contacts enable row level security;
drop policy if exists billing_contacts_admin_all on public.billing_contacts;
create policy billing_contacts_admin_all on public.billing_contacts for all to authenticated using (public.app_is_admin()) with check (public.app_is_admin());

drop trigger if exists billing_contacts_touch on public.billing_contacts;
create trigger billing_contacts_touch before update on public.billing_contacts
  for each row execute function public.app_touch_updated_at();

revoke all on public.billing_contacts from anon;

commit;

notify pgrst, 'reload schema';