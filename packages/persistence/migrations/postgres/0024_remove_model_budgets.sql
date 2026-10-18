-- The project token quota and the monetary project ceiling no longer exist: a model call is never
-- refused or stopped for a token or money limit. `budget_reservations`, `model_calls` and
-- `usage_entries` stay as the accounting ledger of measured usage.
DROP TABLE token_budget_limits;
DROP TABLE budget_limits;
