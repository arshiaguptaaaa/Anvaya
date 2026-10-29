-- Payment-page purchases: the page's own Apps Script emails the customer and the team when the browser reports the
-- payment. page_reported records, per payment id, whether that happened (the Sheet already had the page's row), so
-- the app emails only when the page never did. Additive only.
alter table anvaya.gateway_payments add column if not exists page_payment boolean not null default false;
alter table anvaya.gateway_payments add column if not exists page_reported boolean;
