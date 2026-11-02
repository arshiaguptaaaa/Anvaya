-- Charm pricing (2 Nov 2026): ₹500 → ₹499, ₹1,500 → ₹1,499, ₹2,250 → ₹2,249, ₹4,500 → ₹4,499 (₹3,999 unchanged).
-- Matches the website and payment page. Only rows still at the old price change, so a price edited by hand is kept.
-- Plan keys (1500, 2250, 500mba, 4500) stay as they are: they are identifiers used in links, not prices.
update anvaya.products set price_paise = 49900,  updated_at = now() where public_key = '500mba' and price_paise = 50000;
update anvaya.products set price_paise = 149900, updated_at = now() where public_key = '1500'   and price_paise = 150000;
update anvaya.products set price_paise = 224900, updated_at = now() where public_key = '2250'   and price_paise = 225000;
update anvaya.products set price_paise = 449900, updated_at = now() where public_key = '4500'   and price_paise = 450000;
