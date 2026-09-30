CREATE TABLE works (
  id TEXT PRIMARY KEY, category TEXT NOT NULL CHECK(category IN ('film','tv','music','game')),
  title TEXT NOT NULL CHECK(length(trim(title)) > 0), normalized_title TEXT NOT NULL,
  artist TEXT, manual_metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), deleted_at TEXT
);
CREATE INDEX works_browse ON works(category, normalized_title, id);
CREATE TABLE editions (
  id TEXT PRIMARY KEY, label TEXT, region TEXT, platform TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), deleted_at TEXT
);
CREATE TABLE formats (
  id TEXT PRIMARY KEY, category TEXT NOT NULL CHECK(category IN ('film','tv','music','game')),
  label TEXT NOT NULL CHECK(length(trim(label)) > 0), normalized_label TEXT NOT NULL, builtin_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), deleted_at TEXT,
  UNIQUE(category, normalized_label)
);
CREATE INDEX formats_category ON formats(category, normalized_label);
CREATE TABLE edition_contents (
  id TEXT PRIMARY KEY, edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  coverage_mode TEXT NOT NULL CHECK(coverage_mode IN ('not_applicable','unknown','explicit','complete')),
  UNIQUE(edition_id, work_id)
);
CREATE INDEX edition_contents_work ON edition_contents(work_id);
CREATE TABLE content_seasons (
  content_id TEXT NOT NULL REFERENCES edition_contents(id) ON DELETE RESTRICT,
  season_number INTEGER NOT NULL CHECK(season_number >= 0), PRIMARY KEY(content_id, season_number)
);
CREATE TABLE edition_formats (
  edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  format_id TEXT NOT NULL REFERENCES formats(id) ON DELETE RESTRICT,
  PRIMARY KEY(edition_id, format_id)
);
CREATE INDEX edition_formats_format ON edition_formats(format_id, edition_id);
CREATE TABLE owned_copies (
  id TEXT PRIMARY KEY, edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  label TEXT, condition TEXT NOT NULL CHECK(condition IN ('unknown','new','like_new','very_good','good','acceptable')),
  media_notes TEXT, packaging_notes TEXT, notes TEXT, shelf TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), deleted_at TEXT
);
CREATE INDEX owned_copies_edition ON owned_copies(edition_id);
CREATE INDEX owned_copies_active_shelf ON owned_copies(shelf, id) WHERE deleted_at IS NULL;
CREATE TABLE currencies (
  code TEXT PRIMARY KEY CHECK(length(code) = 3), exponent INTEGER NOT NULL CHECK(exponent >= 0), registry_version TEXT NOT NULL
);
CREATE TABLE acquisitions (
  owned_copy_id TEXT PRIMARY KEY REFERENCES owned_copies(id) ON DELETE RESTRICT,
  purchase_date TEXT, amount_minor INTEGER CHECK(amount_minor >= 0), currency_code TEXT REFERENCES currencies(code) ON DELETE RESTRICT,
  retailer TEXT, CHECK(amount_minor IS NULL OR currency_code IS NOT NULL)
);
CREATE INDEX acquisitions_date_copy ON acquisitions(purchase_date, owned_copy_id);
CREATE INDEX acquisitions_currency ON acquisitions(currency_code);
CREATE TABLE catalogue_state (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1), catalogue_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL, catalogue_revision INTEGER NOT NULL CHECK(catalogue_revision >= 0)
);
CREATE TABLE changesets (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, principal_lineage TEXT NOT NULL,
  origin_conversation_id TEXT, undo_of TEXT REFERENCES changesets(id) ON DELETE RESTRICT, origin_kind TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('applied')),
  request TEXT NOT NULL CHECK(json_valid(request)), result TEXT NOT NULL CHECK(json_valid(result)), created_at TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE INDEX changesets_applied_at ON changesets(applied_at);
CREATE TABLE change_items (
  changeset_id TEXT NOT NULL REFERENCES changesets(id) ON DELETE RESTRICT, sequence INTEGER NOT NULL,
  entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
  before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)),
  before_revision INTEGER, after_revision INTEGER, dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(dependencies_json)),
  PRIMARY KEY(changeset_id, sequence)
);
CREATE INDEX change_items_entity ON change_items(entity_kind, entity_id);
