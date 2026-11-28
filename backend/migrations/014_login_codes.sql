-- Login codes use the same challenge table. This file follows 013_pm_features.sql
-- and does not edit it. Do not apply this file to production or to
-- navigator-postgres from this change. Apply it only to a new isolated database.

ALTER TABLE auth_challenges DROP CONSTRAINT IF EXISTS auth_challenges_purpose_check;

ALTER TABLE auth_challenges
  ADD CONSTRAINT auth_challenges_purpose_check
  CHECK (purpose IN ('verify', 'reset', 'login'));
