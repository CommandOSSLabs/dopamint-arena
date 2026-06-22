DROP TRIGGER IF EXISTS settlement_settled_count ON settlement;
DROP FUNCTION IF EXISTS bump_settled_count();
DROP TABLE IF EXISTS settlement_meta;
DROP TABLE IF EXISTS settlement;
