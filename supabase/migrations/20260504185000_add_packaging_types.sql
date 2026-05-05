-- Add packaging types and factory reserve logic

-- Create packaging_type enum
do $$ begin
  create type packaging_type as enum ('Single', 'Stack', 'Box', 'Case', 'Dozen', 'Crate', 'Bundle', 'Bulk');
exception
  when duplicate_object then null;
end $$;

-- Add packaging_type column to items table
alter table if exists items
add column if not exists packaging_type packaging_type;

-- Add comment explaining factory reserve
comment on table factory_counts is 'Factory stock counts. Note: 1 unit is always reserved and cannot be allocated.';
