import { describe, expect, it } from "vitest";
import { validateRequest } from "../src/core/catalogue/validation";
import {
  affectedCopyList,
  RequestSequence,
  categoryMembershipRows,
  collectionShelves,
  copySelectionLabel,
  formErrorTarget,
  humanizeHistoryChange,
  humanizeHistoryOperations,
  genreSelectOptions,
  metadataEditorValues,
  matchingFormatChoice,
  mergeFormatChoices,
  nextPageCursor,
  nextMutationIntent,
  parseSeasonInput,
  presentChangeFields,
  previousPageCursor,
  tvCoverageSummary,
  validateMetadataInputs,
  workMetadataForEditor,
  standardGenres,
} from "../src/renderer/catalogue-ui-helpers";

describe("catalogue renderer helpers", () => {
  it("shares standard and catalogue genres while retaining a current legacy value", () => {
    expect(
      genreSelectOptions(
        [" Ambient ", "action", "", "Legacy Genre"],
        "Unlisted Genre",
      ),
    ).toEqual([
      ...standardGenres,
      "Ambient",
      "Legacy Genre",
      "Unlisted Genre",
    ]);
  });

  it("merges selected release formats without dropping loaded alternatives", () => {
    const loaded = [
      { id: "dvd", category: "film", label: "DVD", builtinCode: "dvd" },
      { id: "blu-ray", category: "film", label: "Blu-ray", builtinCode: "bluray" },
      { id: "uhd", category: "film", label: "4K UHD", builtinCode: "uhd" },
      { id: "vhs", category: "film", label: "VHS", builtinCode: "vhs" },
    ];
    const selected = [
      { ...loaded[0], id: "other-dvd-row" },
      { id: "off-page", category: "film", label: "Collector Box", builtinCode: null },
    ];

    expect(mergeFormatChoices(loaded, selected).map((choice) => choice.label)).toEqual([
      "DVD", "Blu-ray", "4K UHD", "VHS", "Collector Box",
    ]);
  });

  it("matches format labels by category and normalized label", () => {
    const choices = [
      { id: null, category: "film", label: "DVD", builtinCode: "dvd" },
      { id: "film-disc", category: "film", label: "Disc", builtinCode: null },
      { id: "game-disc", category: "game", label: "Disc", builtinCode: "disc" },
    ];

    expect(matchingFormatChoice(choices, "  ｄｉｓｃ ", "film")).toBe(
      choices[1],
    );
    expect(matchingFormatChoice(choices, "Disc", "game")).toBe(choices[2]);
    expect(matchingFormatChoice(choices, "Disc", "tv")).toBeUndefined();
  });

  it("targets main and included-TV season errors at the real input IDs", () => {
    expect(formErrorTarget("seasons")).toBe("field-included-seasons");
    expect(formErrorTarget("contents.2.seasons")).toBe("included-seasons-2");
  });

  it("shows fixed TV coverage in read-only release summaries", () => {
    expect(tvCoverageSummary([
      { title: "Series", category: "tv", coverageMode: "explicit", seasons: [0, 1, 2] },
      { title: "Unknown series", category: "tv", coverageMode: "unknown", seasons: [] },
      { title: "Complete series", category: "tv", coverageMode: "complete", seasons: [] },
    ])).toEqual([
      "Series: Selected seasons 0, 1, 2",
      "Unknown series: Unknown coverage",
      "Complete series: Complete series; season list unknown",
    ]);
  });

  it("advances and returns to the actual previous page cursor", () => {
    const first = nextPageCursor([], undefined, "page-2");
    expect(first).toEqual({ stack: [undefined], current: "page-2" });
    const second = nextPageCursor(first.stack, first.current, "page-3");
    expect(previousPageCursor(second.stack, second.current)).toEqual({
      stack: [undefined],
      current: "page-2",
      canGoPrevious: true,
    });
    expect(previousPageCursor([], undefined).canGoPrevious).toBe(false);
  });

  it("ignores an older collection response that arrives after a newer request", async () => {
    const sequence = new RequestSequence();
    let rendered = "";
    let resolveOlder!: (value: string) => void;
    const olderResponse = new Promise<string>((resolve) => {
      resolveOlder = resolve;
    });
    const applyIfCurrent = async (request: number, response: Promise<string>) => {
      const value = await response;
      if (sequence.isCurrent(request)) rendered = value;
    };
    const olderRequest = sequence.next();
    const older = applyIfCurrent(olderRequest, olderResponse);
    const newerRequest = sequence.next();

    await applyIfCurrent(newerRequest, Promise.resolve("newer collection"));
    resolveOlder("stale collection");
    await older;

    expect(rendered).toBe("newer collection");
  });

  it("reuses the same mutation intent for an unchanged retry", () => {
    const operations = [{ type: "work.create", title: "Arrival" }];
    const first = nextMutationIntent(null, operations, () => "request-1");
    const retry = nextMutationIntent(
      first,
      structuredClone(operations),
      () => "unexpected-request",
    );
    const changed = nextMutationIntent(
      retry,
      [{ type: "work.create", title: "Solaris" }],
      () => "request-2",
    );

    expect(retry).toBe(first);
    expect(changed).toEqual({
      id: "request-2",
      operations: [{ type: "work.create", title: "Solaris" }],
    });
  });

  it("uses owned-copy identity in selection labels", () => {
    expect(copySelectionLabel("copy-1", "Arrival")).not.toBe(
      copySelectionLabel("copy-2", "Arrival"),
    );
    expect(copySelectionLabel("copy-1", "Arrival")).toContain("copy-1");
  });

  it("uses product language for durable change-history summaries", () => {
    expect(
      humanizeHistoryOperations([
        "create edition",
        "create format",
        "create owned_copy",
        "update work",
      ]),
    ).toEqual([
      "Add release",
      "Add format",
      "Add owned copy",
      "Edit work",
    ]);
    expect(humanizeHistoryChange("delete", "owned_copy")).toBe(
      "Delete owned copy",
    );
  });

  it("renders zero-count categories in the statistics view model", () => {
    expect(
      categoryMembershipRows(
        [
          { category: "film", copyCount: 2 },
          { category: "game", copyCount: 0 },
        ],
        ["film", "tv", "music", "game"],
      ),
    ).toEqual([
      { category: "film", copyCount: 2 },
      { category: "tv", copyCount: 0 },
      { category: "music", copyCount: 0 },
      { category: "game", copyCount: 0 },
    ]);
  });

  it("groups catalogue works into populated shelves or one grid", () => {
    const works = [
      { id: "film-1", category: "film" as const },
      { id: "tv-1", category: "tv" as const },
      { id: "music-1", category: "music" as const },
    ];

    expect(collectionShelves(works, "shelves")).toEqual([
      {
        id: "film-tv",
        title: "Films & television",
        items: works.slice(0, 2),
      },
      {
        id: "music-games",
        title: "Music & games",
        items: works.slice(2),
      },
    ]);
    expect(collectionShelves(works, "grid")).toEqual([
      { id: "all", title: "All catalogue works", items: works },
    ]);
    expect(collectionShelves(works, "shelves", "tv")).toEqual([
      { id: "tv", title: "tv", items: [works[1]] },
    ]);
    expect(collectionShelves([], "shelves")).toEqual([]);
  });

  it("validates release year and genre inputs without altering their values", () => {
    expect(validateMetadataInputs("2001", "science fiction, drama")).toEqual(
      {},
    );
    expect(validateMetadataInputs("2001.5", "drama").year).toBeTruthy();
    expect(validateMetadataInputs("10000", "drama").year).toBeTruthy();
    expect(validateMetadataInputs("", "x".repeat(121)).genre).toBeTruthy();
  });

  it("round-trips supported work descriptions without dropping other metadata", () => {
    const original = {
      year: 1999,
      genres: ["Drama"],
      description: "A remembered description.",
      director: "A. Director",
    };

    expect(metadataEditorValues(original)).toEqual({
      year: "1999",
      genre: "Drama",
      description: "A remembered description.",
    });
    expect(
      workMetadataForEditor(original, {
        year: "2000",
        genre: "Drama, Mystery",
        description: "An updated description.",
      }),
    ).toEqual({
      year: 2000,
      genres: ["Drama", "Mystery"],
      description: "An updated description.",
      director: "A. Director",
    });
    expect(
      workMetadataForEditor(original, {
        year: "1999",
        genre: "Drama",
        description: "",
      }),
    ).not.toHaveProperty("description");
  });

  it("normalizes a legacy single-string genre before saving work metadata", () => {
    const legacy = {
      genre: "Drama",
      director: "A. Director",
    };
    const metadata = workMetadataForEditor(legacy, {
      year: "",
      genre: "Drama",
      description: "",
    });

    expect(metadataEditorValues(legacy).genre).toBe("Drama");
    expect(metadata).toEqual({
      director: "A. Director",
      genres: ["Drama"],
    });
    expect(() =>
      validateRequest({
        contractVersion: 1,
        requestId: "legacy-genre-normalization-v1",
        operations: [
          {
            operationId: "create-work",
            kind: "createWork",
            ref: "$work",
            category: "film",
            title: "Legacy Genre",
            metadata,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("lists every affected copy reference in stable order", () => {
    expect(
      affectedCopyList([
        { id: "cpy_b" },
        { id: "cpy_a" },
      ]),
    ).toBe("- Copy cpy_a\n- Copy cpy_b");
    expect(affectedCopyList([])).toBe("- None");
  });

  it("validates description length and focuses its field error", () => {
    expect(validateMetadataInputs("", "", "x".repeat(10000))).toEqual({});
    expect(
      validateMetadataInputs("", "", "x".repeat(10001)).description,
    ).toBeTruthy();
    expect(formErrorTarget("description")).toBe("field-description");
    expect(formErrorTarget("formats")).toBe("field-formats-required");
    expect(formErrorTarget("title")).toBe("field-title-required");
  });

  it("keeps unknown coverage empty and accepts season zero", () => {
    expect(parseSeasonInput("", "unknown")).toEqual({ seasons: [] });
    expect(parseSeasonInput("0, 2", "explicit")).toEqual({ seasons: [0, 2] });
    expect(parseSeasonInput("", "complete")).toEqual({ seasons: [] });
    expect(parseSeasonInput("", "explicit").error).toBeTruthy();
  });

  it.each(["-1", "foo", "1,,2", "1.5", "1,1"])(
    "retains an error for invalid season input %s",
    (input) => {
      expect(parseSeasonInput(input, "explicit").error).toBeTruthy();
    },
  );

  it("presents known history fields and omits internal or unknown keys", () => {
    expect(
      presentChangeFields({
        title: "Arrival",
        shelf: null,
        requestHash: "secret",
        revision: 3,
      }),
    ).toEqual([
      { field: "Title", value: "Arrival" },
      { field: "Shelf", value: "Unknown" },
    ]);
  });
});
