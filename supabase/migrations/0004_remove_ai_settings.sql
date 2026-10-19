-- AI drafting removed from scope: drop its settings. The ai_runs table stays (empty, harmless) so no data is destroyed.
delete from anvaya.settings where key in ('ai_monthly_cap_paise', 'ai_max_runs_per_month');
