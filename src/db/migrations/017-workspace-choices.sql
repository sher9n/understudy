-- Choices a workspace makes for itself.

-- Whether its calls only ever go to providers that keep nothing. On unless it chose otherwise:
-- turning it off reaches the models with no such provider (o3, the newest Claude models), and its
-- calls still never go to a provider that trains on them.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS zdr_required INTEGER NOT NULL DEFAULT 1;
