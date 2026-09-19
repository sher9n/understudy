-- Finishing the guide is a thing the person DID, not a thing that happened to them.
--
-- Until now the getting started guide ended the moment a call arrived, which is a different
-- event entirely: the developer is mid-sentence, reading step two, and the app moves under
-- them. Traffic arriving is what makes the last step POSSIBLE; pressing the button on it is
-- what ends the guide.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS onboarded_at BIGINT;

-- Anyone already using the app has plainly finished it, and must not be sent back.
UPDATE workspaces SET onboarded_at = COALESCE(onboarded_at, EXTRACT(EPOCH FROM now()) * 1000)
 WHERE onboarded_at IS NULL
   AND EXISTS (SELECT 1 FROM calls c WHERE c.workspace_id = workspaces.id);
