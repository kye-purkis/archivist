import type {
  Category,
  CoverageMode,
  StatisticsResult,
} from "../core/catalogue/contracts";

export type SeasonParseResult = { seasons: number[]; error?: string };

export const standardGenres = [
  "Action",
  "Adventure",
  "Animation",
  "Comedy",
  "Documentary",
  "Drama",
  "Fantasy",
  "Horror",
  "Mystery",
  "Rock",
  "Sci-Fi",
  "Thriller",
  "Other",
];

type FormatChoice = {
  id: string | null;
  category: string;
  label: string;
  builtinCode: string | null;
};

export function genreSelectOptions(
  existingGenres: readonly string[],
  currentValue: string,
): string[] {
  const seen = new Set<string>();
  return [...standardGenres, ...existingGenres, currentValue]
    .map((genre) => genre.trim())
    .filter((genre) => {
      if (!genre) return false;
      const normalized = genre.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

export class RequestSequence {
  private value = 0;

  next(): number {
    return ++this.value;
  }

  isCurrent(request: number): boolean {
    return request === this.value;
  }
}

export function metadataEditorValues(metadata?: Record<string, unknown>) {
  return {
    year:
      typeof metadata?.year === "number" && Number.isSafeInteger(metadata.year)
        ? String(metadata.year)
        : "",
    genre: Array.isArray(metadata?.genres)
      ? metadata.genres
          .filter((value): value is string => typeof value === "string")
          .join(", ")
      : typeof metadata?.genre === "string"
        ? metadata.genre
        : "",
    description:
      typeof metadata?.description === "string" ? metadata.description : "",
  };
}

export function workMetadataForEditor(
  metadata: Record<string, unknown> | undefined,
  values: { year: string; genre: string; description: string },
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  delete next.genre;
  if (values.year) next.year = Number(values.year);
  else delete next.year;
  const genres = values.genre
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (genres.length) next.genres = genres;
  else delete next.genres;
  if (values.description.trim()) next.description = values.description;
  else delete next.description;
  return next;
}

export function affectedCopyList(
  references: Array<{ id: string }>,
): string {
  if (!references.length) return "- None";
  return [...references]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id }) => `- Copy ${id}`)
    .join("\n");
}

export type MutationIntent<T> = { id: string; operations: T };

export function nextMutationIntent<T>(
  current: MutationIntent<T> | null,
  operations: T,
  createId: () => string,
): MutationIntent<T> {
  return current &&
    JSON.stringify(current.operations) === JSON.stringify(operations)
    ? current
    : { id: createId(), operations };
}

export function categoryMembershipRows(
  memberships: StatisticsResult["categoryMemberships"],
  categories: Category[],
): Array<{ category: Category; copyCount: number }> {
  return categories.map((category) => ({
    category,
    copyCount:
      memberships.find((membership) => membership.category === category)
        ?.copyCount ?? 0,
  }));
}

export type CollectionView = "shelves" | "grid";

export function collectionShelves<T extends { category: Category }>(
  works: T[],
  view: CollectionView,
  category?: Category,
): Array<{ id: string; title: string; items: T[] }> {
  if (category) {
    const items = works.filter((work) => work.category === category);
    return items.length ? [{ id: category, title: category, items }] : [];
  }
  if (view === "grid") {
    return works.length
      ? [{ id: "all", title: "All catalogue works", items: works }]
      : [];
  }
  return [
    {
      id: "film-tv",
      title: "Films & television",
      items: works.filter((work) => work.category === "film" || work.category === "tv"),
    },
    {
      id: "music-games",
      title: "Music & games",
      items: works.filter((work) => work.category === "music" || work.category === "game"),
    },
  ].filter((shelf) => shelf.items.length > 0);
}

export function copySelectionLabel(copyId: string, title: string): string {
  return `Select owned copy ${copyId} of ${title}`;
}

export function matchingFormatChoice<T extends FormatChoice>(
  choices: T[],
  label: string,
  category: string,
): T | undefined {
  const normalized = label.trim().normalize("NFKC").toLowerCase();
  return choices.find(
    (choice) =>
      choice.category === category &&
      choice.label.trim().normalize("NFKC").toLowerCase() === normalized,
  );
}

export function humanizeHistoryChange(operation: string, kind: string): string {
  const entity: Record<string, string> = {
    work: "work",
    edition: "release",
    owned_copy: "owned copy",
    format: "format",
  };
  const verb: Record<string, string> = {
    create: "Add",
    update: "Edit",
    delete: "Delete",
    restore: "Restore",
  };
  const operationLabel = verb[operation] ?? operation;
  const entityLabel = entity[kind] ?? kind.replaceAll("_", " ");
  return `${operationLabel} ${entityLabel}`;
}

export function humanizeHistoryOperations(operations: string[]): string[] {
  return operations.map((item) => {
    const [operation, ...kindParts] = item.split(" ");
    return humanizeHistoryChange(operation, kindParts.join(" "));
  });
}

export function mergeFormatChoices<T extends FormatChoice>(
  loaded: T[],
  selected: T[],
): T[] {
  const seen = new Set<string>();
  return [...loaded, ...selected].filter((choice) => {
    const key = choice.builtinCode
      ? `builtin:${choice.category}:${choice.builtinCode}`
      : choice.id
        ? `id:${choice.id}`
        : `custom:${choice.category}:${choice.label.trim().normalize("NFKC").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formErrorTarget(field: string): string | undefined {
  if (field === "seasons") return "field-included-seasons";
  const includedSeasons = /^contents\.(\d+)\.seasons$/.exec(field);
  if (includedSeasons) return `included-seasons-${includedSeasons[1]}`;
  const knownFields: Record<string, string> = {
    year: "field-release-year",
    genre: "field-genre",
    description: "field-description",
    formats: "field-formats-required",
    price: "field-price",
    purchaseDate: "field-purchase-date",
    title: "field-title-required",
  };
  return knownFields[field];
}

export function tvCoverageSummary(
  contents: Array<{
    title?: string | null;
    category?: string | null;
    coverageMode?: string;
    seasons?: number[];
  }>,
): string[] {
  return contents
    .filter((content) => content.category === "tv")
    .map((content) => {
      const title = content.title?.trim() || "TV work";
      const seasons = content.seasons ?? [];
      if (content.coverageMode === "explicit") {
        return `${title}: Selected seasons ${seasons.join(", ")}`;
      }
      if (content.coverageMode === "complete") {
        return seasons.length
          ? `${title}: Complete series; seasons ${seasons.join(", ")}`
          : `${title}: Complete series; season list unknown`;
      }
      return `${title}: Unknown coverage`;
    });
}

export function nextPageCursor(
  stack: Array<string | undefined>,
  current: string | undefined,
  next: string,
) {
  return { stack: [...stack, current], current: next };
}

export function previousPageCursor(
  stack: Array<string | undefined>,
  current: string | undefined,
) {
  if (stack.length === 0) return { stack, current, canGoPrevious: false };
  const nextStack = [...stack];
  const previous = nextStack.pop();
  return { stack: nextStack, current: previous, canGoPrevious: true };
}

export function validateMetadataInputs(
  year: string,
  genre: string,
  description = "",
) {
  const errors: Record<string, string> = {};
  if (
    year.trim() &&
    (!/^\d+$/.test(year.trim()) || Number(year) < 1 || Number(year) > 9999)
  ) {
    errors.year = "Enter a whole release year from 1 to 9999.";
  }
  const genres = genre
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (genres.length > 100 || genres.some((item) => item.length > 120)) {
    errors.genre =
      "Use up to 100 genre labels, each no longer than 120 characters.";
  }
  if (description.length > 10000)
    errors.description = "Use a description no longer than 10,000 characters.";
  return errors;
}

/** Parse the editor's raw season text without hiding malformed tokens. */
export function parseSeasonInput(
  raw: string,
  mode: CoverageMode,
): SeasonParseResult {
  if (mode === "unknown" || mode === "not_applicable") return { seasons: [] };
  if (raw.trim() === "")
    return mode === "explicit"
      ? {
          seasons: [],
          error: "Enter at least one season for selected seasons coverage.",
        }
      : { seasons: [] };
  const tokens = raw.split(",").map((token) => token.trim());
  if (tokens.some((token) => token === "" || !/^\d+$/.test(token))) {
    return {
      seasons: [],
      error: "Enter whole season numbers separated by commas.",
    };
  }
  const seasons = tokens.map(Number);
  if (seasons.some((season) => !Number.isSafeInteger(season) || season < 0)) {
    return { seasons: [], error: "Season numbers must be zero or greater." };
  }
  if (new Set(seasons).size !== seasons.length)
    return { seasons: [], error: "Remove duplicate season numbers." };
  return { seasons };
}

  const labels: Record<string, string> = {
  title: "Title",
  category: "Category",
  artist: "Artist",
  metadata: "Metadata",
  year: "Release year",
  genres: "Genres",
  label: "Release label",
  region: "Region",
  platform: "Platform",
  contents: "Included titles",
  coverageMode: "Season coverage",
  seasons: "Seasons",
  formats: "Formats",
  condition: "Condition",
  shelf: "Shelf",
  notes: "Notes",
  mediaNotes: "Media notes",
  packagingNotes: "Packaging notes",
  date: "Purchase date",
  amount: "Price",
  currency: "Currency",
  retailer: "Retailer",
  deletedAt: "Deleted",
  coverage: "Season coverage",
  work: "Included title",
  workTitle: "Included title",
  workCategory: "Included title category",
  acquisition: "Purchase",
  currentWorkTitle: "Included title (current label; may have changed)",
  currentFormatLabel: "Format (current label; may have changed)",
  currentEditionLabel: "Release (current label; may have changed)",
  deleted: "Record status",
};

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Unknown";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (
      value.every((item) => typeof item === "string") &&
      value.some((item) => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(item))
    ) {
      return "References are recorded; their original labels are unavailable.";
    }
    return value.map(displayValue).join("; ") || "None";
  }
  if (typeof value === "object") {
    const nested = presentChangeFields(value).map(
      ({ field, value: shown }) => `${field}: ${shown}`,
    );
    return nested.join("; ") || "No recorded details";
  }
  const vocabulary: Record<string, string> = {
    film: "Film",
    tv: "TV",
    music: "Music",
    game: "Games",
    unknown: "Unknown",
    not_applicable: "Not applicable",
    explicit: "Selected seasons",
    complete: "Complete series",
    like_new: "Like New",
    very_good: "Very Good",
    acceptable: "Acceptable",
  };
  return vocabulary[String(value)] ?? String(value);
}

/** Converts allowlisted history projections into field-labelled user-facing rows. */
export function presentChangeFields(
  value: unknown,
): Array<{ field: string; value: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entries = Object.entries(value as Record<string, unknown>);
  return entries
    .filter(
      ([key]) =>
        key in labels &&
        !["id", "revision", "createdAt", "updatedAt"].includes(key),
    )
    .map(([key, item]) => ({
      field: labels[key],
      value: key === "deleted"
        ? (item ? "Deleted" : "Active")
        : key === "formats" &&
        Array.isArray(item) &&
        item.every((entry) => typeof entry === "string")
          ? "Format references are recorded; original labels are unavailable."
          : displayValue(item),
    }));
}
