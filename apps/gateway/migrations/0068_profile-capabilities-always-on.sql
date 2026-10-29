-- Every agent now manages itself, searches the web, learns from its work and talks with the
-- other agents; the switches that turned those off are gone.
ALTER TABLE profiles
  DROP COLUMN allow_self_management,
  DROP COLUMN allow_web_search,
  DROP COLUMN learn_from_work,
  DROP COLUMN reachable_by_agents;
