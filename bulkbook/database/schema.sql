-- =====================================================================
-- Bulkbook database for Supabase (PostgreSQL)
-- Run this ONCE in: Supabase dashboard > SQL Editor > New query.
--
-- Design rules
--  1. Row-level security (RLS) is ON for every table.
--  2. The browser can only READ tables (and only what its role may see).
--     Every WRITE goes through a function below. The functions check who
--     is calling, recompute prices on the server, and run as one transaction.
--  3. Who is calling = the Clerk user id in the login token (auth.jwt()->>'sub'),
--     matched to a row in public.profiles. No profile = no access.
--  4. Cost prices and profit columns are hidden from employees.
-- =====================================================================

-- New functions must not be callable by everybody by default (PostgreSQL gives EXECUTE to PUBLIC unless told otherwise).
alter default privileges revoke execute on functions from public;

-- ---------- settings (one row) ----------
create table public.app_settings (
  id boolean primary key default true check (id),
  shop_name text not null default 'My Wholesale Shop',
  timezone text not null default 'UTC',            -- used for "today", daily and monthly reports
  retention_months integer not null default 4 check (retention_months between 1 and 120)
);
insert into public.app_settings default values;

-- ---------- people ----------
create table public.profiles (
  clerk_user_id text primary key,                   -- Clerk user id, for example user_2abc...
  full_name text not null,
  login_name text unique,
  role text not null check (role in ('owner','employee')),
  status text not null default 'active' check (status in ('active','deleted')),
  created_at timestamptz not null default now()
);

-- ---------- goods ----------
-- Stock is stored as a whole number in the smallest unit:
--   box goods: pieces        bag goods: half-bags (2 per bag)
create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  category text not null,
  sell_type text not null check (sell_type in ('box','bag')),
  pieces_per_box integer,
  price_piece numeric(12,2),
  price_box numeric(12,2),
  price_bag numeric(12,2),
  cost numeric(12,2) check (cost is null or cost >= 0),   -- per piece (box goods) or per bag (bag goods)
  stock_base integer not null default 0 check (stock_base >= 0),
  low_base integer not null default 0 check (low_base >= 0),
  created_by text references public.profiles(clerk_user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint box_fields check (sell_type <> 'box' or (pieces_per_box >= 2 and price_piece > 0 and price_box > 0 and price_bag is null)),
  constraint bag_fields check (sell_type <> 'bag' or (price_bag > 0 and pieces_per_box is null and price_piece is null and price_box is null))
);
create sequence public.product_sku_seq start 1000;

-- ---------- customers (borrowers) ----------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  phone_key text not null unique,                    -- last 9 digits, so +233 24 555 0102 and 024 555 0102 count as the same number
  arch_spent numeric(14,2) not null default 0,       -- total of receipts already deleted by the clean-up
  arch_count integer not null default 0,
  created_by text references public.profiles(clerk_user_id),
  created_at timestamptz not null default now()
);

-- ---------- receipts ----------
create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  no bigint generated always as identity (start with 1001) unique,
  created_at timestamptz not null default now(),
  created_by text not null references public.profiles(clerk_user_id),
  employee_name text not null,                       -- name kept on the receipt even if the employee is deleted later
  customer_id uuid references public.customers(id),  -- null = walk-in who paid in full
  total numeric(14,2) not null check (total >= 0),
  cogs numeric(14,2) not null default 0,             -- cost of the goods sold (owner only)
  paid_at timestamptz                                -- set the moment the balance reaches zero
);
create table public.receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  unit text not null check (unit in ('box','piece','bag','half')),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null,
  line_total numeric(14,2) not null,
  line_cogs numeric(14,2) not null default 0
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete cascade,
  customer_id uuid references public.customers(id),
  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('Cash','Mobile money','Bank transfer')),
  kind text not null check (kind in ('sale','later')),   -- paid at the sale, or paid back later
  received_by text not null references public.profiles(clerk_user_id),
  received_by_name text not null,
  created_at timestamptz not null default now()
);

-- ---------- totals kept after old receipts are deleted ----------
create table public.monthly_archive (
  month date not null,
  employee_name text not null,
  receipts integer not null default 0,
  sales numeric(14,2) not null default 0,
  cogs numeric(14,2) not null default 0,
  primary key (month, employee_name)
);

create table public.activity_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_name text,
  action text not null,
  detail text
);

create index on public.receipts (created_at);
create index on public.receipts (customer_id);
create index on public.receipts (created_by);
create index on public.receipts (paid_at) where paid_at is not null;
create index on public.receipt_lines (receipt_id);
create index on public.payments (receipt_id);
create index on public.payments (created_at);

-- =====================================================================
-- Who is calling?
-- =====================================================================
create or replace function public.my_profile()
returns public.profiles language sql stable security definer set search_path = public, pg_temp as $$
  select p.* from public.profiles p
  where p.clerk_user_id = (select auth.jwt() ->> 'sub') and p.status = 'active'
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.my_profile() m where m.clerk_user_id is not null)
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select m.role = 'owner' from public.my_profile() m where m.clerk_user_id is not null), false)
$$;

-- =====================================================================
-- Row-level security
-- =====================================================================
alter table public.app_settings    enable row level security;
alter table public.profiles        enable row level security;
alter table public.products        enable row level security;
alter table public.customers      enable row level security;
alter table public.receipts        enable row level security;
alter table public.receipt_lines   enable row level security;
alter table public.payments        enable row level security;
alter table public.monthly_archive enable row level security;
alter table public.activity_log    enable row level security;

create policy settings_read on public.app_settings for select to authenticated using ((select public.is_staff()));
create policy profiles_read on public.profiles for select to authenticated
  using (clerk_user_id = (select auth.jwt() ->> 'sub') or (select public.is_owner()));
create policy products_read on public.products for select to authenticated using ((select public.is_staff()));
create policy customers_read on public.customers for select to authenticated using ((select public.is_staff()));
-- Staff see their own receipts, and every receipt that belongs to a named customer (needed to collect what is owed).
create policy receipts_read on public.receipts for select to authenticated
  using ((select public.is_owner())
         or ((select public.is_staff()) and (created_by = (select auth.jwt() ->> 'sub') or customer_id is not null)));
create policy lines_read on public.receipt_lines for select to authenticated
  using (exists (select 1 from public.receipts r where r.id = receipt_id));
create policy payments_read on public.payments for select to authenticated
  using (exists (select 1 from public.receipts r where r.id = receipt_id));
create policy archive_read on public.monthly_archive for select to authenticated using ((select public.is_owner()));
create policy log_read on public.activity_log for select to authenticated using ((select public.is_owner()));
-- There is deliberately NO insert / update / delete policy: the browser cannot write directly.

-- =====================================================================
-- Table privileges (second lock, on top of RLS)
-- =====================================================================
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant usage on schema public to authenticated;
grant select on public.app_settings, public.profiles, public.payments, public.activity_log, public.monthly_archive to authenticated;
-- Column lists leave out cost columns, so employees can never read them.
grant select (id, sku, name, category, sell_type, pieces_per_box, price_piece, price_box, price_bag, stock_base, low_base, created_by, created_at, updated_at)
  on public.products to authenticated;
grant select (id, name, phone, created_by, created_at) on public.customers to authenticated;
grant select (id, no, created_at, created_by, employee_name, customer_id, total, paid_at) on public.receipts to authenticated;
grant select (id, receipt_id, product_id, product_name, unit, quantity, unit_price, line_total) on public.receipt_lines to authenticated;

-- =====================================================================
-- Reading helpers
-- =====================================================================
-- Owner only: cost price of each product.
create or replace function public.product_costs()
returns table (id uuid, cost numeric) language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.cost from public.products p where (select public.is_owner())
$$;

-- Everyone on staff: each customer with what they owe. Total bought is shown to the owner only.
create or replace function public.customer_summary()
returns table (id uuid, name text, phone text, owes numeric, oldest_unpaid timestamptz,
               last_purchase timestamptz, spent numeric, receipts_count integer)
language sql stable security definer set search_path = public, pg_temp as $$
  with b as (
    select r.customer_id, r.created_at, r.total,
           r.total - coalesce((select sum(p.amount) from public.payments p where p.receipt_id = r.id), 0) as bal
    from public.receipts r where r.customer_id is not null
  )
  select c.id, c.name, c.phone,
         coalesce(sum(b.bal) filter (where b.bal > 0), 0)::numeric,
         min(b.created_at) filter (where b.bal > 0),
         max(b.created_at),
         case when (select public.is_owner()) then coalesce(sum(b.total), 0) + c.arch_spent end,
         case when (select public.is_owner()) then (count(b.customer_id) + c.arch_count)::int end
  from public.customers c left join b on b.customer_id = c.id
  where (select public.is_staff())
  group by c.id
  order by c.name
$$;

create or replace function public.customer_unpaid(p_customer_id uuid)
returns table (id uuid, no bigint, created_at timestamptz, total numeric, balance numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, r.no, r.created_at, r.total,
         r.total - coalesce((select sum(p.amount) from public.payments p where p.receipt_id = r.id), 0)
  from public.receipts r
  where r.customer_id = p_customer_id and r.paid_at is null and (select public.is_staff())
  order by r.created_at, r.no
$$;

-- Daily figures for the last N days, one row per day and person. Owner sees everyone, an employee only their own.
create or replace function public.report_daily(p_days integer default 30)
returns table (day date, employee_name text, receipts integer, sales numeric, received numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.profiles; tz text; owner boolean; first_day date;
begin
  select * into me from public.my_profile();
  if me.clerk_user_id is null then raise exception 'You are not allowed to do this.' using errcode = '42501'; end if;
  owner := me.role = 'owner';
  select s.timezone into tz from public.app_settings s;
  first_day := (now() at time zone tz)::date - (greatest(least(p_days, 366), 1) - 1);
  return query
  select x.d, x.n, sum(x.c)::int, sum(x.s), sum(x.m)
  from (
    select (r.created_at at time zone tz)::date as d, r.employee_name as n, 1 as c, r.total as s, 0::numeric as m
      from public.receipts r where (owner or r.created_by = me.clerk_user_id) and (r.created_at at time zone tz)::date >= first_day
    union all
    select (p.created_at at time zone tz)::date, p.received_by_name, 0, 0::numeric, p.amount
      from public.payments p where (owner or p.received_by = me.clerk_user_id) and (p.created_at at time zone tz)::date >= first_day
  ) x
  group by x.d, x.n order by x.d desc, x.n;
end $$;

-- Monthly figures including months whose receipts were already deleted. Profit (cogs) is for the owner only.
create or replace function public.report_monthly(p_months integer default 12)
returns table (month date, employee_name text, receipts integer, sales numeric, cogs numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.profiles; tz text; owner boolean; first_month date;
begin
  select * into me from public.my_profile();
  if me.clerk_user_id is null then raise exception 'You are not allowed to do this.' using errcode = '42501'; end if;
  owner := me.role = 'owner';
  select s.timezone into tz from public.app_settings s;
  first_month := (date_trunc('month', now() at time zone tz)::date - (greatest(least(p_months, 120), 1) - 1) * interval '1 month')::date;
  return query
  select x.m, x.n, sum(x.c)::int, sum(x.s), case when owner then sum(x.g) end
  from (
    select date_trunc('month', r.created_at at time zone tz)::date as m, r.employee_name as n, 1 as c, r.total as s, r.cogs as g
      from public.receipts r where (owner or r.created_by = me.clerk_user_id)
    union all
    select a.month, a.employee_name, a.receipts, a.sales, a.cogs
      from public.monthly_archive a where (owner or a.employee_name = me.full_name)
  ) x
  where x.m >= first_month
  group by x.m, x.n order by x.m desc, x.n;
end $$;

-- Owner only: how many receipts the clean-up would delete right now.
create or replace function public.old_receipts_count()
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from public.receipts r, public.app_settings s
  where (select public.is_owner()) and r.paid_at is not null
    and r.paid_at <= now() - make_interval(months => s.retention_months)
$$;

-- =====================================================================
-- Writing: every change goes through one of these functions
-- =====================================================================
create or replace function public._log(p_actor text, p_action text, p_detail text default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.activity_log (actor_name, action, detail) values (p_actor, p_action, p_detail)
$$;

-- Make a sale and its receipt. Prices and totals are recomputed here, never trusted from the browser.
-- p_lines example: [{"product_id":"...","unit":"box","quantity":2}]   unit = box | piece | bag | half
-- A half bag always costs exactly half of the bag price.
-- Walk-in (no customer): pays in full. Customer: can pay part now and owe the rest.
create or replace function public.create_sale(
  p_customer_id uuid, p_new_name text, p_new_phone text, p_paid numeric, p_method text, p_lines jsonb)
returns table (out_receipt_id uuid, out_receipt_no bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me public.profiles; ln record; pr public.products;
  needs jsonb := '{}'::jsonb; out_lines jsonb := '[]'::jsonb;
  base int; up numeric; lt numeric; lc numeric; total numeric := 0; cogs numeric := 0;
  cid uuid := null; paid numeric; rid uuid; rno bigint; k text; v text; digs text; pkey text; dup text;
begin
  select * into me from public.my_profile();
  if me.clerk_user_id is null then raise exception 'You are not allowed to do this.' using errcode = '42501'; end if;
  if p_method is null or p_method not in ('Cash','Mobile money','Bank transfer') then raise exception 'Choose how it was paid.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 100 then
    raise exception 'The order has no items.'; end if;

  -- lock the goods in a fixed order so two sales at the same time cannot deadlock or oversell
  perform 1 from public.products
   where id in (select (e ->> 'product_id')::uuid from jsonb_array_elements(p_lines) e) order by id for update;

  for ln in select (e ->> 'product_id')::uuid as pid, e ->> 'unit' as unit, (e ->> 'quantity')::numeric as qty
            from jsonb_array_elements(p_lines) e loop
    select * into pr from public.products where id = ln.pid;
    if not found then raise exception 'One of the goods no longer exists.'; end if;
    if ln.qty is null or ln.qty < 1 or ln.qty <> trunc(ln.qty) or ln.qty > 100000 then
      raise exception 'Quantities must be whole numbers of 1 or more.'; end if;
    if not ((pr.sell_type = 'box' and ln.unit in ('box','piece')) or (pr.sell_type = 'bag' and ln.unit in ('bag','half'))) then
      raise exception 'You cannot sell % like that.', pr.name; end if;
    base := (case ln.unit when 'box' then ln.qty * pr.pieces_per_box when 'bag' then ln.qty * 2 else ln.qty end)::int;
    up := case ln.unit when 'box' then pr.price_box when 'piece' then pr.price_piece when 'bag' then pr.price_bag
                       else round(pr.price_bag / 2, 2) end;
    lt := round(ln.qty * up, 2);
    lc := round(base * coalesce(case when pr.sell_type = 'box' then pr.cost else pr.cost / 2 end, 0), 2);
    total := total + lt; cogs := cogs + lc;
    needs := jsonb_set(needs, array[pr.id::text], to_jsonb(coalesce((needs ->> pr.id::text)::int, 0) + base));
    out_lines := out_lines || jsonb_build_object('product_id', pr.id, 'name', pr.name, 'unit', ln.unit,
                                                 'qty', ln.qty::int, 'up', up, 'lt', lt, 'lc', lc);
  end loop;

  for k, v in select key, value from jsonb_each_text(needs) loop
    select * into pr from public.products where id = k::uuid;
    if pr.stock_base < v::int then raise exception 'Not enough % in stock.', pr.name; end if;
  end loop;

  if p_customer_id is not null then
    perform 1 from public.customers where id = p_customer_id;
    if not found then raise exception 'Customer not found.'; end if;
    cid := p_customer_id;
  elsif (p_new_name is not null and btrim(p_new_name) <> '') or (p_new_phone is not null and btrim(p_new_phone) <> '') then
    digs := regexp_replace(coalesce(p_new_phone, ''), '\D', '', 'g');
    if btrim(coalesce(p_new_name, '')) = '' then raise exception 'Enter the customer''s name.'; end if;
    if coalesce(p_new_phone, '') !~ '^\+?[0-9 ()-]+$' or length(digs) < 9 or length(digs) > 15 then
      raise exception 'Enter a phone number with 9 to 15 digits.'; end if;
    pkey := right(digs, 9);
    select name into dup from public.customers where phone_key = pkey;
    if dup is not null then raise exception 'That phone number already belongs to %.', dup; end if;
    insert into public.customers (name, phone, phone_key, created_by)
      values (btrim(p_new_name), btrim(p_new_phone), pkey, me.clerk_user_id) returning id into cid;
  end if;

  total := round(total, 2);
  if cid is null then paid := total;
  else
    paid := coalesce(p_paid, total);
    if paid < 0 or paid > total or round(paid, 2) <> paid then raise exception 'Paid now must be between 0 and the total.'; end if;
  end if;

  insert into public.receipts (created_by, employee_name, customer_id, total, cogs, paid_at)
    values (me.clerk_user_id, me.full_name, cid, total, round(cogs, 2), case when paid >= total then now() end)
    returning id, no into rid, rno;
  insert into public.receipt_lines (receipt_id, product_id, product_name, unit, quantity, unit_price, line_total, line_cogs)
    select rid, (l ->> 'product_id')::uuid, l ->> 'name', l ->> 'unit', (l ->> 'qty')::int,
           (l ->> 'up')::numeric, (l ->> 'lt')::numeric, (l ->> 'lc')::numeric
    from jsonb_array_elements(out_lines) l;
  if paid > 0 then
    insert into public.payments (receipt_id, customer_id, amount, method, kind, received_by, received_by_name)
      values (rid, cid, paid, p_method, 'sale', me.clerk_user_id, me.full_name);
  end if;
  update public.products p set stock_base = p.stock_base - n.value::int, updated_at = now()
    from jsonb_each_text(needs) n where p.id = n.key::uuid;

  perform public._log(me.full_name, 'Made receipt ' || rno, total::text || case when paid < total then ', owing ' || (total - paid)::text else ', paid' end);
  return query select rid, rno;
end $$;

-- A borrower pays something back. The money goes to their oldest unpaid receipt first.
create or replace function public.record_payment(p_customer_id uuid, p_amount numeric, p_method text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles; r record; owed numeric := 0; left_amt numeric; take numeric; done jsonb := '[]'::jsonb; cname text;
begin
  select * into me from public.my_profile();
  if me.clerk_user_id is null then raise exception 'You are not allowed to do this.' using errcode = '42501'; end if;
  if p_method is null or p_method not in ('Cash','Mobile money','Bank transfer') then raise exception 'Choose how it was paid.'; end if;
  select name into cname from public.customers where id = p_customer_id;
  if cname is null then raise exception 'Customer not found.'; end if;
  if p_amount is null or p_amount <= 0 or round(p_amount, 2) <> p_amount then
    raise exception 'Enter an amount above zero with at most 2 decimal places.'; end if;

  for r in select rc.id, rc.no, rc.total - coalesce((select sum(p.amount) from public.payments p where p.receipt_id = rc.id), 0) as bal
           from public.receipts rc where rc.customer_id = p_customer_id and rc.paid_at is null
           order by rc.created_at, rc.no for update of rc loop
    owed := owed + r.bal;
  end loop;
  if p_amount > owed then raise exception 'That is more than the customer owes (%).', owed; end if;

  left_amt := p_amount;
  for r in select rc.id, rc.no, rc.total - coalesce((select sum(p.amount) from public.payments p where p.receipt_id = rc.id), 0) as bal
           from public.receipts rc where rc.customer_id = p_customer_id and rc.paid_at is null
           order by rc.created_at, rc.no for update of rc loop
    exit when left_amt <= 0;
    take := least(left_amt, r.bal);
    insert into public.payments (receipt_id, customer_id, amount, method, kind, received_by, received_by_name)
      values (r.id, p_customer_id, take, p_method, 'later', me.clerk_user_id, me.full_name);
    if take >= r.bal then update public.receipts set paid_at = now() where id = r.id; end if;
    left_amt := left_amt - take;
    done := done || jsonb_build_object('no', r.no, 'paid_in_full', take >= r.bal);
  end loop;

  perform public._log(me.full_name, 'Confirmed payment', p_amount::text || ' from ' || cname);
  return jsonb_build_object('customer', cname, 'amount', p_amount, 'receipts', done);
end $$;

-- Add new goods (staff). Only the owner can set the cost price.
create or replace function public.add_product(
  p_name text, p_category text, p_sell_type text, p_pieces_per_box integer,
  p_price_piece numeric, p_price_box numeric, p_price_bag numeric, p_cost numeric, p_stock_base integer)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles; pid uuid; sku text;
begin
  select * into me from public.my_profile();
  if me.clerk_user_id is null then raise exception 'You are not allowed to do this.' using errcode = '42501'; end if;
  if btrim(coalesce(p_name, '')) = '' or btrim(coalesce(p_category, '')) = '' then raise exception 'Enter a name and a category.'; end if;
  if p_stock_base is null or p_stock_base < 0 then raise exception 'Stock cannot be negative.'; end if;
  if p_sell_type = 'box' then
    if p_pieces_per_box is null or p_pieces_per_box < 2 or p_price_piece is null or p_price_piece <= 0 or p_price_box is null or p_price_box <= 0 then
      raise exception 'Enter pieces in a box and both prices.'; end if;
    p_price_bag := null;
  elsif p_sell_type = 'bag' then
    if p_price_bag is null or p_price_bag <= 0 then raise exception 'Enter the price of a bag.'; end if;
    p_pieces_per_box := null; p_price_piece := null; p_price_box := null;
  else raise exception 'Choose boxes or bags.'; end if;
  sku := coalesce(nullif(upper(left(regexp_replace(p_name, '[^A-Za-z0-9]', '', 'g'), 3)), ''), 'NEW') || '-' || nextval('public.product_sku_seq');
  insert into public.products (sku, name, category, sell_type, pieces_per_box, price_piece, price_box, price_bag, cost, stock_base, low_base, created_by)
    values (sku, btrim(p_name), btrim(p_category), p_sell_type, p_pieces_per_box, p_price_piece, p_price_box, p_price_bag,
            case when me.role = 'owner' then p_cost end, p_stock_base,
            case when p_sell_type = 'box' then p_pieces_per_box else 10 end, me.clerk_user_id)
    returning id into pid;
  perform public._log(me.full_name, 'Added goods', btrim(p_name));
  return pid;
end $$;

-- Change prices, cost and stock of existing goods (owner only).
create or replace function public.update_product(
  p_id uuid, p_price_piece numeric, p_price_box numeric, p_price_bag numeric, p_cost numeric, p_stock_base integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles; pr public.products;
begin
  select * into me from public.my_profile();
  if me.clerk_user_id is null or me.role <> 'owner' then raise exception 'Only the owner can change prices.' using errcode = '42501'; end if;
  select * into pr from public.products where id = p_id for update;
  if not found then raise exception 'Goods not found.'; end if;
  if p_stock_base is null or p_stock_base < 0 then raise exception 'Stock cannot be negative.'; end if;
  if pr.sell_type = 'box' then
    if p_price_piece is null or p_price_piece <= 0 or p_price_box is null or p_price_box <= 0 then raise exception 'Enter both prices.'; end if;
    update public.products set price_piece = p_price_piece, price_box = p_price_box, cost = p_cost, stock_base = p_stock_base, updated_at = now() where id = p_id;
  else
    if p_price_bag is null or p_price_bag <= 0 then raise exception 'Enter the price of a bag.'; end if;
    update public.products set price_bag = p_price_bag, cost = p_cost, stock_base = p_stock_base, updated_at = now() where id = p_id;
  end if;
  perform public._log(me.full_name, 'Changed goods', pr.name);
end $$;

-- Add stock to existing goods (staff).
create or replace function public.add_stock(p_id uuid, p_add_base integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles; pr public.products;
begin
  select * into me from public.my_profile();
  if me.clerk_user_id is null then raise exception 'You are not allowed to do this.' using errcode = '42501'; end if;
  if p_add_base is null or p_add_base <= 0 then raise exception 'Enter a stock amount above zero.'; end if;
  update public.products set stock_base = stock_base + p_add_base, updated_at = now() where id = p_id returning * into pr;
  if not found then raise exception 'Goods not found.'; end if;
  perform public._log(me.full_name, 'Added stock', pr.name || ', ' || p_add_base::text);
end $$;

create or replace function public.update_settings(p_shop_name text, p_timezone text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles;
begin
  select * into me from public.my_profile();
  if me.clerk_user_id is null or me.role <> 'owner' then raise exception 'Only the owner can change settings.' using errcode = '42501'; end if;
  if btrim(coalesce(p_shop_name, '')) = '' then raise exception 'Enter the shop name.'; end if;
  perform now() at time zone p_timezone;      -- raises an error if the time zone name is not valid
  update public.app_settings set shop_name = btrim(p_shop_name), timezone = p_timezone;
  perform public._log(me.full_name, 'Changed settings', null);
end $$;

-- ---------- clean-up of old receipts ----------
-- Deletes receipts that were paid in full more than N months ago (N = retention_months, default 4,
-- counted from the day they were fully paid). Before deleting, the monthly totals and each customer's
-- lifetime total are saved, so reports stay correct. Receipts that are still owing are never deleted.
create or replace function public._purge_old_receipts(p_actor text)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer; tz text; cutoff timestamptz;
begin
  select s.timezone, now() - make_interval(months => s.retention_months) into tz, cutoff from public.app_settings s;
  with elig as (
    select id, created_at, employee_name, total, cogs, customer_id
    from public.receipts where paid_at is not null and paid_at <= cutoff for update
  ),
  a as (
    insert into public.monthly_archive (month, employee_name, receipts, sales, cogs)
    select date_trunc('month', created_at at time zone tz)::date, employee_name, count(*), sum(total), sum(cogs)
    from elig group by 1, 2
    on conflict (month, employee_name) do update
      set receipts = public.monthly_archive.receipts + excluded.receipts,
          sales = public.monthly_archive.sales + excluded.sales,
          cogs = public.monthly_archive.cogs + excluded.cogs
    returning 1
  ),
  c as (
    update public.customers cu set arch_spent = cu.arch_spent + s.sp, arch_count = cu.arch_count + s.n
    from (select customer_id, sum(total) as sp, count(*)::int as n from elig where customer_id is not null group by customer_id) s
    where cu.id = s.customer_id returning 1
  ),
  d as (delete from public.receipts where id in (select id from elig) returning 1)
  select count(*)::int into n from d;
  perform public._log(p_actor, 'Deleted old receipts', n::text || ' receipts');
  return n;
end $$;

create or replace function public.purge_old_receipts()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles;
begin
  select * into me from public.my_profile();
  if me.clerk_user_id is null or me.role <> 'owner' then raise exception 'Only the owner can delete old receipts.' using errcode = '42501'; end if;
  return public._purge_old_receipts(me.full_name);
end $$;

-- =====================================================================
-- Who may call what (this block runs last, so it covers every function above)
-- =====================================================================
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.my_profile(), public.is_staff(), public.is_owner() to authenticated;
grant execute on function
  public.product_costs(), public.customer_summary(), public.customer_unpaid(uuid),
  public.report_daily(integer), public.report_monthly(integer), public.old_receipts_count(),
  public.create_sale(uuid, text, text, numeric, text, jsonb), public.record_payment(uuid, numeric, text),
  public.add_product(text, text, text, integer, numeric, numeric, numeric, numeric, integer),
  public.update_product(uuid, numeric, numeric, numeric, numeric, integer),
  public.add_stock(uuid, integer), public.update_settings(text, text), public.purge_old_receipts()
  to authenticated;
-- Only the server (service role key) may run the scheduled clean-up and write the activity log directly.
grant execute on function public._purge_old_receipts(text), public._log(text, text, text) to service_role;
