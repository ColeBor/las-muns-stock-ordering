-- Overdraft: the amount a hard override forced past available factory
-- stock. Soft overrides + normal allocations leave this at 0. When >0
-- the factory has to scramble (bake more or pull from another source)
-- because the store gets the full requested qty regardless.
alter table public.allocations
  add column if not exists overdraft integer not null default 0;
