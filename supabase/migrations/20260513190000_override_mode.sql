-- Allocation override "mode":
--   soft (default) — respects factory stock; shortfall recorded when factory short.
--   hard           — bypasses factory stock; allocation row gets the full
--                    requested qty even if factory available_qty is lower
--                    (factory will run negative on that item).
alter table public.allocation_overrides
  add column if not exists mode text not null default 'soft';

alter table public.allocation_overrides
  drop constraint if exists allocation_overrides_mode_check;

alter table public.allocation_overrides
  add constraint allocation_overrides_mode_check
    check (mode in ('soft', 'hard'));
