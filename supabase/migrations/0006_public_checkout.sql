-- Public payment page → server checkout. A product can be bought from the public page by its public key
-- (e.g. "1500", "500mba"); orders remember the referral code and the discount the server applied.
-- Additive only.
alter table anvaya.products add column if not exists public_key text;
create unique index if not exists products_public_key_idx on anvaya.products (public_key) where public_key is not null;
alter table anvaya.orders add column if not exists ref_code text not null default '';
alter table anvaya.orders add column if not exists discount_paise bigint not null default 0 check (discount_paise >= 0);
alter table anvaya.orders add column if not exists source text not null default 'dashboard';
