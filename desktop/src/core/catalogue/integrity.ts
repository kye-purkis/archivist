import Database from 'better-sqlite3';
import { CatalogueError } from './contracts';

type Row = Record<string, unknown>;

function safeNumber(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Stored integer is outside the supported range.');
  }
  return result;
}

export function validateActiveGraph(db: Database.Database, errorCode = 'SCHEMA_MISMATCH'): void {
  const editions = db.prepare('SELECT id FROM editions WHERE deleted_at IS NULL').all() as Row[];
  for (const edition of editions) {
    const contents = db.prepare(`SELECT ec.id,ec.coverage_mode,w.category,w.deleted_at,
      (SELECT count(*) FROM content_seasons cs WHERE cs.content_id=ec.id) AS season_count
      FROM edition_contents ec JOIN works w ON w.id=ec.work_id WHERE ec.edition_id=?`).all(edition.id) as Row[];
    const formats = db.prepare(`SELECT f.category,f.deleted_at FROM edition_formats ef
      JOIN formats f ON f.id=ef.format_id WHERE ef.edition_id=?`).all(edition.id) as Row[];
    if (contents.some((item) => item.deleted_at !== null) || formats.some((item) => item.deleted_at !== null)) {
      throw new CatalogueError(errorCode, 'An active edition references a deleted work or format.');
    }
    if (!contents.length || !formats.length) {
      throw new CatalogueError(errorCode, 'An active edition is missing work contents or formats.');
    }
    const categories = new Set(contents.map((item) => String(item.category)));
    for (const category of categories) {
      if (!formats.some((item) => item.category === category)) {
        throw new CatalogueError(errorCode, 'Edition formats do not cover every included work category.');
      }
    }
    for (const format of formats) {
      if (!categories.has(String(format.category))) {
        throw new CatalogueError(errorCode, 'An edition format does not match an included work category.');
      }
    }
    for (const content of contents) {
      const seasonCount = safeNumber(content.season_count);
      const mode = String(content.coverage_mode);
      const category = String(content.category);
      if (
        (category === 'tv' && (mode === 'not_applicable' || (mode === 'explicit' && seasonCount === 0) || (mode === 'unknown' && seasonCount > 0))) ||
        (category !== 'tv' && (mode !== 'not_applicable' || seasonCount > 0))
      ) {
        throw new CatalogueError(errorCode, 'TV coverage and season rows do not agree.');
      }
    }
  }
  const badCopy = db.prepare(`SELECT c.id FROM owned_copies c JOIN editions e ON e.id=c.edition_id
    WHERE c.deleted_at IS NULL AND e.deleted_at IS NOT NULL LIMIT 1`).get();
  if (badCopy) throw new CatalogueError(errorCode, 'An active copy references a deleted edition.');
}
