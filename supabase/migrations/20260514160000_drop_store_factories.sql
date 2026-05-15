-- Operations are now single-factory. The per-store factory priority mapping
-- is no longer used — the allocator pulls from the one factory directly.
drop table if exists public.store_factories;
