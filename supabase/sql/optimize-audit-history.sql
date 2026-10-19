-- Run outside a transaction. Keep writes available while building the index.
-- Match module equality plus the ID cursor/order used by loadAuditHistory.
create index concurrently if not exists audits_module_history_cursor_idx
on public.audits(module,id);
analyze public.audits;
