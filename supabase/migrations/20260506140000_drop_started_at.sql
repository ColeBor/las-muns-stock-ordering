-- order_cycles.started_at duplicated created_at — both default to now() at
-- insert, neither was user-editable, and the UI now shows order_date as the
-- meaningful "when was this order placed" date. Drop the redundant column;
-- existing queries already switched to ordering by created_at.

alter table public.order_cycles drop column if exists started_at;
