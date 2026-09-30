import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  LibraryBig,
  Layers,
  BarChart3,
  Settings,
  Plus,
  Search,
  SlidersHorizontal,
  ChevronDown,
  Pencil,
  Trash2,
  Undo2,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Sun,
  Moon,
} from "lucide-react";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PhysicalFormatChart } from "./PhysicalFormatChart";
import { ArchivistMark } from "./components/archivist-mark";
import { GenreSelect } from "./components/catalogue/genre-select";
import type { SafeResult } from "../contracts/catalogue";
import type {
  AppliedReceipt,
  CatalogueDetail,
  CatalogueSearchRequest,
  Category,
  Condition,
  CoverageMode,
  Operation,
  CatalogueLookups,
  ChangeHistoryDetail,
  ChangeHistorySummary,
  PickerResult,
  RecordReference,
  StatisticsResult,
} from "../core/catalogue/contracts";
import type { CatalogueRecoverySummary } from "../core/catalogue/recovery";
import {
  affectedCopyList,
  collectionShelves,
  type CollectionView,
  RequestSequence,
  categoryMembershipRows,
  copySelectionLabel,
  formErrorTarget,
  humanizeHistoryChange,
  humanizeHistoryOperations,
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
} from "./catalogue-ui-helpers";
import { HistoryProjectionFields } from "./HistoryProjectionFields";

type WorkRow = {
  id: string;
  category: Category;
  title: string;
  revision: number;
  editionCount: number;
  copyCount: number;
};
type CopyRow = {
  id: string;
  revision: number;
  editionId: string;
  title: string;
  category: Category;
  shelf: string | null;
  condition: Condition;
  purchaseDate: string | null;
};
type FormatRow = {
  id: string | null;
  revision: number | null;
  category: Category;
  label: string;
  builtinCode: string | null;
  builtin: boolean;
};
type Screen = "collection" | "statistics" | "settings";
type EditorMode = "new" | "work" | "edition" | "copy" | "another";
type CatalogueForm = {
  category: Category;
  title: string;
  artist: string;
  year: string;
  genre: string;
  description: string;
  platform: string;
  unknownPlatform: boolean;
  releaseLabel: string;
  region: string;
  coverage: CoverageMode;
  seasons: string;
  formatIds: string[];
  customFormat: string;
  customFormatAdded: boolean;
  customFormatCategory: Category;
  shelf: string;
  condition: Condition;
  notes: string;
  mediaNotes: string;
  packagingNotes: string;
  price: string;
  currency: string;
  purchaseDate: string;
  retailer: string;
  workId: string;
  editionId: string;
  editionRevision?: number;
  sourceEditionRevision?: number;
  targetEditionId?: string;
  targetEditionRevision?: number;
  targetEditionTitle?: string;
  copyId?: string;
  copyRevision?: number;
  workRevision?: number;
  copyCount?: number;
  affectedCopyRefs: RecordReference[];
  originalMetadata?: Record<string, unknown>;
  contents?: Array<{
    work: string;
    coverage: CoverageMode;
    seasons: number[];
    seasonsInput?: string;
    title?: string;
    category?: Category;
  }>;
  formats?: Array<{
    id: string;
    category: Category;
    label: string;
    builtinCode: string | null;
  }>;
};
const categories: Category[] = ["film", "tv", "music", "game"];
const categoryNames: Record<Category, string> = {
  film: "Film",
  tv: "TV",
  music: "Music",
  game: "Games",
};
const releaseYearOptions = (currentValue: string) => {
  const latestYear = new Date().getFullYear() + 1;
  const years = Array.from({ length: latestYear - 1888 + 1 }, (_, index) =>
    String(latestYear - index),
  );
  return currentValue && !years.includes(currentValue)
    ? [currentValue, ...years]
    : years;
};
const conditionNames: Record<Condition, string> = {
  unknown: "Unknown",
  new: "New",
  like_new: "Like New",
  very_good: "Very Good",
  good: "Good",
  acceptable: "Acceptable",
};
const emptyForm = (): CatalogueForm => ({
  category: "film",
  title: "",
  artist: "",
  year: "",
  genre: "",
  description: "",
  platform: "",
  unknownPlatform: true,
  releaseLabel: "",
  region: "",
  coverage: "unknown",
  seasons: "",
  formatIds: [],
  customFormat: "",
  customFormatAdded: false,
  customFormatCategory: "film",
  shelf: "",
  condition: "unknown",
  notes: "",
  mediaNotes: "",
  packagingNotes: "",
  price: "",
  currency: "GBP",
  purchaseDate: "",
  retailer: "",
  workId: "",
  editionId: "",
  affectedCopyRefs: [],
});
const newId = () => crypto.randomUUID();
const formatKey = (x: FormatRow) =>
  x.builtinCode
    ? `builtin:${x.category}:${x.builtinCode}`
    : (x.id ?? `builtin:${x.category}:${x.label}`);
const detailIdentity = (d: CatalogueDetail) =>
  d.type === "owned_copy" || d.type === "edition" ? d.record.id : d.id;
const formatCategoriesFor = (form: CatalogueForm): Category[] => [
  ...new Set([
    form.category,
    ...(form.contents ?? []).flatMap((content) =>
      content.category ? [content.category] : [],
    ),
  ]),
];
export default function CatalogueApp() {
  const [screen, setScreen] = useState<Screen>("collection");
  const [dark, setDark] = useState(false);
  const [collectionView, setCollectionView] =
    useState<CollectionView>("shelves");
  const [status, setStatus] = useState("Loading collection…");
  const [works, setWorks] = useState<WorkRow[]>([]);
  const [displayedFilterKey, setDisplayedFilterKey] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState<string | undefined>();
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | undefined>();
  const [genre, setGenre] = useState("");
  const [formatId, setFormatId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedWork, setSelectedWork] = useState<string | null>(null);
  const [copies, setCopies] = useState<CopyRow[]>([]);
  const [copyCursor, setCopyCursor] = useState<string | null>(null);
  const [copyLoading, setCopyLoading] = useState(false);
  const [selectedCopies, setSelectedCopies] = useState<string[]>([]);
  const [selectedCopyRefs, setSelectedCopyRefs] = useState<
    Record<string, CopyRow>
  >({});
  const [detail, setDetail] = useState<CatalogueDetail | null>(null);
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [currentConflict, setCurrentConflict] = useState<CatalogueDetail[]>([]);
  const [editorLoading, setEditorLoading] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const formRef = useRef(form);
  formRef.current = form;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [additionalDetailsOpen, setAdditionalDetailsOpen] = useState(false);
  const [formatChoicesOpen, setFormatChoicesOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shelfDialogOpen, setShelfDialogOpen] = useState(false);
  const [shelfValue, setShelfValue] = useState("");
  const [shelfError, setShelfError] = useState("");
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{
    changesetId: string;
    label: string;
  } | null>(null);
  const [toast, setToast] = useState("");
  const [allFormats, setAllFormats] = useState<FormatRow[]>([]);
  const [formatChoiceCursors, setFormatChoiceCursors] = useState<
    Partial<Record<Category, string>>
  >({});
  const [filterFormatCursors, setFilterFormatCursors] = useState<
    Partial<Record<Category, string>>
  >({});
  const [workOptions, setWorkOptions] = useState<PickerResult["items"]>([]);
  const [includedWorkOptions, setIncludedWorkOptions] = useState<
    PickerResult["items"]
  >([]);
  const [includedWorkCursor, setIncludedWorkCursor] = useState<string | null>(
    null,
  );
  const [editionOptions, setEditionOptions] = useState<PickerResult["items"]>(
    [],
  );
  const [workPickerCursor, setWorkPickerCursor] = useState<string | null>(null);
  const [editionPickerCursor, setEditionPickerCursor] = useState<string | null>(
    null,
  );
  const [lookups, setLookups] = useState<CatalogueLookups>();
  const [stats, setStats] = useState<StatisticsResult>();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState("");
  const [restorePreview, setRestorePreview] = useState<{
    previewToken: string;
    backup: CatalogueRecoverySummary;
  } | null>(null);
  const [history, setHistory] = useState<ChangeHistorySummary[]>([]);
  const [historyDetail, setHistoryDetail] = useState<ChangeHistoryDetail>();
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyDetailCursor, setHistoryDetailCursor] = useState<string | null>(
    null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [filterFormatLoading, setFilterFormatLoading] = useState(false);
  const [includedQuery, setIncludedQuery] = useState("");
  const includedQueryRef = useRef(includedQuery);
  includedQueryRef.current = includedQuery;
  const [targetReleaseQuery, setTargetReleaseQuery] = useState("");
  const targetReleaseQueryRef = useRef(targetReleaseQuery);
  targetReleaseQueryRef.current = targetReleaseQuery;
  const historyDetailSeq = useRef(0);
  const filterFormatSeq = useRef(0);
  const workSelectionSeq = useRef(0);
  const seq = useRef(new RequestSequence());
  const copySeq = useRef(0);
  const detailSeq = useRef(0);
  const editorSeq = useRef(0);
  const formatSeq = useRef(0);
  const workPickerSeq = useRef(0);
  const editionPickerSeq = useRef(0);
  const pendingMutation = useRef<{
    id: string;
    operations: Operation[];
  } | null>(null);
  const undoRequestIds = useRef(new Map<string, string>());
  const undoInFlight = useRef(new Set<string>());
  const editorInvoker = useRef<HTMLElement | null>(null);
  const shelfInvoker = useRef<HTMLElement | null>(null);
  const setF = <K extends keyof CatalogueForm>(
    key: K,
    value: CatalogueForm[K],
  ) => setForm((f) => ({ ...f, [key]: value }));
  const read = <T,>(p: Promise<SafeResult<T>>) => p;
  const loadWorks = useCallback(
    async (request: CatalogueSearchRequest, replace = true) => {
      const current = seq.current.next();
      const requestFiltersKey = JSON.stringify(
        (({ cursor: _cursor, ...filters }) => filters)(request),
      );
      setBusy(true);
      setStatus("Loading collection…");
      const r = await read(window.catalogue.search({ ...request, limit: 50 }));
      if (
        !seq.current.isCurrent(current) ||
        requestFiltersKey !== filtersKeyRef.current
      )
        return;
      setBusy(false);
      if (!r.ok) {
        if (r.error.code === "STALE_CURSOR" && request.cursor) {
          setCursorStack([]);
          setPageCursor(undefined);
          void loadWorks({ ...request, cursor: undefined }, true);
          return;
        }
        setStatus(r.error.message);
        return;
      }
      setWorks((old) =>
        replace
          ? (r.value.items as WorkRow[])
          : [...old, ...(r.value.items as WorkRow[])],
      );
      setDisplayedFilterKey(requestFiltersKey);
      setPageCursor(request.cursor);
      setCursor(r.value.nextCursor);
      setStatus("");
    },
    [],
  );
  const currentFilters = useCallback(
    (pageCursor?: string) => ({
      query: query || undefined,
      category,
      genre: genre || undefined,
      formatId: formatId || undefined,
      purchaseDateFrom: from || undefined,
      purchaseDateTo: to || undefined,
      cursor: pageCursor,
    }),
    [query, category, genre, formatId, from, to],
  );
  const filtersKey = JSON.stringify({
    query: query || undefined,
    category,
    genre: genre || undefined,
    formatId: formatId || undefined,
    purchaseDateFrom: from || undefined,
    purchaseDateTo: to || undefined,
  });
  const filtersKeyRef = useRef(filtersKey);
  filtersKeyRef.current = filtersKey;
  const onCategoryValueChange = (value: string) => {
    if (value === "all") {
      setCategory(undefined);
      return;
    }
    const nextCategory = categories.find((candidate) => candidate === value);
    if (nextCategory) setCategory(nextCategory);
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      setCursorStack([]);
      setPageCursor(undefined);
      void loadWorks(currentFilters(), true);
    }, 180);
    return () => clearTimeout(timer);
  }, [currentFilters, loadWorks]);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    return () => root.classList.remove("dark");
  }, [dark]);
  useEffect(() => {
    void window.catalogue.lookups().then((r) => {
      if (r.ok) setLookups(r.value);
    });
  }, []);
  useEffect(() => {
    const firstField = Object.keys(fieldErrors)[0];
    if (firstField) {
      const targetId = formErrorTarget(firstField);
      const target = targetId ? document.getElementById(targetId) : null;
      (
        target ?? document.querySelector<HTMLElement>('[aria-invalid="true"]')
      )?.focus();
    }
  }, [fieldErrors]);
  useEffect(() => {
    if (editor === null) {
      editorInvoker.current?.focus();
      editorInvoker.current = null;
    }
  }, [editor]);
  useEffect(() => {
    if (!shelfDialogOpen) {
      shelfInvoker.current?.focus();
      shelfInvoker.current = null;
    }
  }, [shelfDialogOpen]);
  useEffect(() => {
    if (!selectedWork) {
      setCopies([]);
      setCopyCursor(null);
      setCopyLoading(false);
      return;
    }
    const current = ++copySeq.current;
    setCopyLoading(true);
    void window.catalogue
      .copies({ workId: selectedWork, limit: 50 })
      .then((r) => {
        if (current !== copySeq.current) return;
        setCopyLoading(false);
        if (r.ok) {
          setCopies(r.value.items);
          setCopyCursor(r.value.nextCursor);
        } else setToast(r.error.message);
      });
  }, [selectedWork]);
  useEffect(() => {
    if (screen === "statistics" || screen === "collection")
      void window.catalogue.statistics().then((r) => {
        if (r.ok) setStats(r.value);
        else setToast(r.error.message);
      });
    if (screen === "settings")
      void window.catalogue.changesList({ limit: 30 }).then((r) => {
        if (r.ok) {
          setHistory(r.value.items);
          setHistoryCursor(r.value.nextCursor);
        } else setToast(r.error.message);
      });
  }, [screen]);
  const selectWork = (workId: string) => {
    copySeq.current++;
    detailSeq.current++;
    workSelectionSeq.current++;
    setDetailLoading(false);
    setDetail(null);
    setSelectedWork(workId);
    setCopies([]);
    setCopyCursor(null);
    setCopyLoading(true);
    setSelectedCopies([]);
    setSelectedCopyRefs({});
  };
  const closeDetail = () => {
    detailSeq.current++;
    setDetailLoading(false);
    setDetail(null);
  };
  const clearWorkSelection = () => {
    copySeq.current++;
    setSelectedWork(null);
    setCopies([]);
    setCopyCursor(null);
    setCopyLoading(false);
    setSelectedCopies([]);
    setSelectedCopyRefs({});
    closeDetail();
  };
  const reloadCopies = async (workId = selectedWork) => {
    if (!workId) return;
    const current = ++copySeq.current;
    const r = await window.catalogue.copies({ workId, limit: 50 });
    if (current !== copySeq.current) return;
    if (r.ok) {
      setCopies(r.value.items);
      setCopyCursor(r.value.nextCursor);
    } else setToast(r.error.message);
  };
  const loadDetail = async (
    kind: "work" | "edition" | "owned_copy",
    id: string,
  ) => {
    const current = ++detailSeq.current;
    setDetail(null);
    setDetailLoading(true);
    const r = await window.catalogue.detail(kind, id);
    if (current !== detailSeq.current) return;
    setDetailLoading(false);
    if (r.ok) setDetail(r.value);
    else {
      setDetail(null);
      setToast(r.error.message);
    }
  };
  const loadFormatChoices = async (cat: Category, extra: Category[] = []) => {
    const request = ++formatSeq.current;
    const cats = [...new Set([cat, ...extra])];
    const results = await Promise.all(
      cats.map((c) => window.catalogue.formats({ category: c, limit: 100 })),
    );
    const items = results.flatMap((r) => (r.ok ? r.value.items : []));
    if (request !== formatSeq.current) return items;
    setAllFormats(items);
    const cursors: Partial<Record<Category, string>> = {};
    results.forEach((r, index) => {
      if (r.ok && r.value.nextCursor) cursors[cats[index]] = r.value.nextCursor;
    });
    setFormatChoiceCursors(cursors);
    const failed = results.find((r) => !r.ok);
    if (failed) setToast(failed.error.message);
    return items;
  };
  const loadMoreEditorFormats = async (cat: Category) => {
    const cursor = formatChoiceCursors[cat];
    if (!cursor) return;
    const request = formatSeq.current;
    const r = await window.catalogue.formats({
      category: cat,
      limit: 100,
      cursor,
    });
    if (request !== formatSeq.current || formatChoiceCursors[cat] !== cursor)
      return;
    if (!r.ok) {
      setToast(r.error.message);
      return;
    }
    setAllFormats((xs) => {
      const seen = new Set(xs.map(formatKey));
      return [...xs, ...r.value.items.filter((x) => !seen.has(formatKey(x)))];
    });
    setFormatChoiceCursors((xs) => ({
      ...xs,
      [cat]: r.value.nextCursor ?? undefined,
    }));
  };
  const beginEditor = async (
    mode: EditorMode,
    kind?: "work" | "edition" | "owned_copy",
    id?: string,
  ) => {
    editorInvoker.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const request = ++editorSeq.current;
    setCurrentConflict([]);
    setWorkOptions([]);
    setIncludedWorkOptions([]);
    setIncludedWorkCursor(null);
    setEditionOptions([]);
    setWorkPickerCursor(null);
    setEditionPickerCursor(null);
    setIncludedQuery("");
    setTargetReleaseQuery("");
    setForm(emptyForm());
    setFormError("");
    setFieldErrors({});
    setAdditionalDetailsOpen(false);
    setFormatChoicesOpen(false);
    setEditorLoading(mode !== "new");
    setEditor(mode);
    if (mode === "new") {
      await loadFormatChoices("film");
      if (request === editorSeq.current) setEditorLoading(false);
      return;
    }
    if (mode === "another" && detail?.type === "owned_copy") {
      await loadFormatChoices(
        detail.edition?.contents[0]?.work?.category ?? "film",
      );
      if (request !== editorSeq.current) return;
      setF("editionId", detail.record.editionId);
      if (detail.edition)
        setF("editionRevision", detail.edition.record.revision);
      if (detail.edition) {
        const c = detail.edition.contents[0];
        const chosenCategory = c?.work?.category ?? "film";
        setF("category", chosenCategory);
        setF("customFormatCategory", chosenCategory);
        setF("title", c?.work?.title ?? "");
        setF(
          "formatIds",
          detail.edition.formats.map((x) => x.id),
        );
      }
      setEditorLoading(false);
      return;
    }
    if (!kind || !id) {
      setEditorLoading(false);
      return;
    }
    const r = await window.catalogue.detail(kind, id);
    if (request !== editorSeq.current) return;
    if (!r.ok) {
      setEditorLoading(false);
      setToast(r.error.message);
      return;
    }
    const d = r.value;
    if (d.type === "work") {
      await loadFormatChoices(d.category);
      if (request !== editorSeq.current) return;
      const metadata = metadataEditorValues(d.metadata);
      setForm((f) => ({
        ...f,
        category: d.category,
        customFormatCategory: d.category,
        title: d.title,
        artist: d.artist ?? "",
        ...metadata,
        workId: d.id,
        workRevision: d.revision,
        copyCount: d.ownedCopyRefs.length,
        affectedCopyRefs: d.ownedCopyRefs,
        originalMetadata: d.metadata,
      }));
      setEditorLoading(false);
    } else if (d.type === "owned_copy") {
      const ed = d.edition;
      const first = ed?.contents[0];
      const work = first?.work;
      await loadFormatChoices(work?.category ?? "film");
      if (request !== editorSeq.current) return;
      const w = work ? await window.catalogue.detail("work", work.id) : null;
      if (request !== editorSeq.current) return;
      const wd = w?.ok && w.value.type === "work" ? w.value : null;
      const metadata = metadataEditorValues(wd?.metadata);
      setForm((f) => ({
        ...f,
        category: work?.category ?? "film",
        customFormatCategory: work?.category ?? "film",
        title: work?.title ?? "",
        artist: wd?.artist ?? "",
        ...metadata,
        platform: ed?.record.platform ?? "",
        unknownPlatform: !ed?.record.platform,
        releaseLabel: ed?.record.label ?? "",
        region: ed?.record.region ?? "",
        coverage: first?.coverageMode ?? "unknown",
        seasons: first?.seasons.join(",") ?? "",
        formatIds: ed?.formats.map((x) => x.id) ?? [],
        shelf: d.record.shelf ?? "",
        condition: d.record.condition,
        notes: d.record.notes ?? "",
        mediaNotes: d.record.mediaNotes ?? "",
        packagingNotes: d.record.packagingNotes ?? "",
        price: d.acquisition?.amount ?? "",
        currency: d.acquisition?.currency ?? "GBP",
        purchaseDate: d.acquisition?.date ?? "",
        retailer: d.acquisition?.retailer ?? "",
        workId: work?.id ?? "",
        editionId: ed?.record.id ?? "",
        copyId: d.record.id,
        copyRevision: d.record.revision,
        editionRevision: ed?.record.revision,
        sourceEditionRevision: ed?.record.revision,
        workRevision: wd?.revision,
      }));
      setEditorLoading(false);
    } else if (d.type === "edition") {
      const first = d.contents[0];
      const w = first?.work;
      await loadFormatChoices(
        w?.category ?? "film",
        d.contents
          .map((x) => x.work?.category)
          .filter((x): x is Category => !!x),
      );
      if (request !== editorSeq.current) return;
      setAllFormats((loaded) =>
        mergeFormatChoices(
          loaded,
          d.formats.map((x) => ({
            id: x.id,
            revision: x.revision,
            category: x.category,
            label: x.label,
            builtinCode: x.builtinCode,
            builtin: !!x.builtinCode,
          })),
        ),
      );
      const wd = w ? await window.catalogue.detail("work", w.id) : null;
      if (request !== editorSeq.current) return;
      const workDetail = wd?.ok && wd.value.type === "work" ? wd.value : null;
      const metadata = metadataEditorValues(workDetail?.metadata);
      setForm((f) => ({
        ...f,
        category: w?.category ?? "film",
        customFormatCategory: w?.category ?? "film",
        title: w?.title ?? "",
        artist: workDetail?.artist ?? "",
        ...metadata,
        platform: d.record.platform ?? "",
        unknownPlatform: !d.record.platform,
        releaseLabel: d.record.label ?? "",
        region: d.record.region ?? "",
        coverage: first?.coverageMode ?? "unknown",
        seasons: first?.seasons.join(",") ?? "",
        formatIds: d.formats.map((x) =>
          formatKey({
            id: x.id,
            revision: x.revision,
            category: x.category,
            label: x.label,
            builtinCode: x.builtinCode,
            builtin: !!x.builtinCode,
          }),
        ),
        workId: w?.id ?? "",
        editionId: d.record.id,
        editionRevision: d.record.revision,
        copyCount: d.ownedCopyRefs.length,
        affectedCopyRefs: d.ownedCopyRefs,
        contents: d.contents.map((x) => ({
          work: x.workId,
          coverage: x.coverageMode,
          seasons: x.seasons,
          seasonsInput: x.seasons.join(", "),
          title: x.work?.title ?? "Unavailable work",
          category: x.work?.category,
        })),
        formats: d.formats.map((x) => ({
          id: x.id,
          category: x.category,
          label: x.label,
          builtinCode: x.builtinCode,
        })),
        workRevision: workDetail?.revision,
      }));
      setEditorLoading(false);
    }
  };
  const startFormatChoices = async (cat: Category) => {
    setF("category", cat);
    setF("customFormatCategory", cat);
    setF("customFormatAdded", false);
    await loadFormatChoices(
      cat,
      (form.contents ?? []).flatMap((c) => (c.category ? [c.category] : [])),
    );
  };
  const mutation = async (ops: Operation[], label: string) => {
    const intent = nextMutationIntent(pendingMutation.current, ops, newId);
    pendingMutation.current = intent;
    setSaving(true);
    setFormError("");
    try {
      const r = await window.catalogue.apply({
        contractVersion: 1,
        requestId: intent.id,
        operations: intent.operations,
      });
      setSaving(false);
      if (!r.ok) {
        setFormError(r.error.message);
        if (!editor) setToast(r.error.message);
        if (r.error.operationErrors) {
          const fields: Record<string, string> = {};
          for (const e of r.error.operationErrors)
            if (e.field) {
              const key =
                e.operationId === "custom-format" && e.field === "label"
                  ? "customFormat"
                  : e.field === "amount"
                    ? "price"
                    : e.field === "date"
                      ? "purchaseDate"
                      : e.field === "metadata.year"
                        ? "year"
                        : e.field === "metadata.genres"
                          ? "genre"
                          : e.field;
              fields[key] = e.message;
            }
          setFieldErrors(fields);
        }
        if (r.error.code === "CONFLICT") {
          if (selectedWork) await reloadCopies();
          await loadFormatChoices(
            form.category,
            (form.contents ?? []).flatMap((x) =>
              x.category ? [x.category] : [],
            ),
          );
          const currentRecords: CatalogueDetail[] = [];
          for (const ref of r.error.recordRefs ?? []) {
            if (
              ref.type === "work" &&
              editor === "work" &&
              ref.id === form.workId
            )
              setF("workRevision", ref.revision);
            if (ref.type === "edition" && ref.id === form.editionId)
              setF("editionRevision", ref.revision);
            if (ref.type === "edition" && editor === "copy") {
              if (ref.id === form.editionId)
                setF("sourceEditionRevision", ref.revision);
              if (ref.id === form.targetEditionId)
                setF("targetEditionRevision", ref.revision);
            }
            if (["work", "edition", "owned_copy"].includes(ref.type)) {
              const current = await window.catalogue.detail(
                ref.type as "work" | "edition" | "owned_copy",
                ref.id,
              );
              if (current.ok) {
                currentRecords.push(current.value);
              }
              if (
                ref.type === "owned_copy" &&
                current.ok &&
                current.value.type === "owned_copy"
              ) {
                const c = current.value;
                const work = c.edition?.contents[0]?.work;
                const row: CopyRow = {
                  id: c.record.id,
                  revision: c.record.revision,
                  editionId: c.record.editionId,
                  title: work?.title ?? "Unavailable work",
                  category: work?.category ?? "film",
                  shelf: c.record.shelf,
                  condition: c.record.condition,
                  purchaseDate: c.acquisition?.date ?? null,
                };
                setSelectedCopyRefs((xs) => ({ ...xs, [row.id]: row }));
                if (editor === "copy" && form.copyId === row.id)
                  setF("copyRevision", row.revision);
              }
            }
          }
          setCurrentConflict(currentRecords);
          setFormError(
            `${r.error.message} The current record values are shown below. Review them against your entered changes before saving again.`,
          );
        }
        return null;
      }
      pendingMutation.current = null;
      await onApplied(r.value, label);
      return r.value;
    } catch {
      setSaving(false);
      setFormError(
        "The save result is unknown. Retry with the form unchanged to replay the same request ID and body.",
      );
      if (!editor)
        setToast(
          "The result is unknown. Retry the same action to safely check whether it applied.",
        );
      return null;
    }
  };
  const onApplied = async (receipt: AppliedReceipt, label: string) => {
    const detailBeforeMutation = detail;
    const deletedOpenedCopy =
      detailBeforeMutation?.type === "owned_copy" &&
      label === "Delete" &&
      selectedCopies.includes(detailBeforeMutation.record.id);
    setUndo({ changesetId: receipt.changesetId, label });
    setToast(`${label} saved.`);
    setEditor(null);
    setSelectedCopies([]);
    setSelectedCopyRefs({});
    await loadWorks(currentFilters());
    if (selectedWork) await reloadCopies();
    if (deletedOpenedCopy) {
      closeDetail();
    } else if (detailBeforeMutation && detailBeforeMutation.type !== "format") {
      const kind = detailBeforeMutation.type;
      const id = detailIdentity(detailBeforeMutation);
      await loadDetail(kind, id);
    }
    if (screen === "statistics" || screen === "collection") {
      const r = await window.catalogue.statistics();
      if (r.ok) setStats(r.value);
      else setToast(r.error.message);
    }
    if (screen === "settings") {
      const r = await window.catalogue.changesList({ limit: 30 });
      if (r.ok) {
        setHistory(r.value.items);
        setHistoryCursor(r.value.nextCursor);
      } else setToast(r.error.message);
    }
  };
  const createFormatOps = (
    operations: Operation[],
    refs: string[],
    cat: Category,
  ) => {
    const chosen = allFormats.filter(
      (x) =>
        form.formatIds.includes(formatKey(x)) &&
        (x.category === cat ||
          (form.contents ?? []).some((c) => c.category === x.category)),
    );
    for (const [index, x] of chosen.entries()) {
      if (x.id) refs.push(x.id);
      else {
        const ref = `$format${index}`;
        operations.push({
          operationId: `format-${index}`,
          kind: "createFormat",
          ref,
          category: x.category,
          label: x.label,
          builtinCode: x.builtinCode,
        });
        refs.push(ref);
      }
    }
    const listed = new Set(chosen.flatMap((x) => (x.id ? [x.id] : [])));
    if (editor === "edition")
      for (const old of form.formats ?? [])
        if (form.formatIds.includes(old.id) && !listed.has(old.id))
          refs.push(old.id);
    if (form.customFormatAdded && form.customFormat.trim()) {
      const customCategory = form.customFormatCategory;
      const existing = matchingFormatChoice(
        allFormats,
        form.customFormat,
        customCategory,
      );
      if (existing?.id) refs.push(existing.id);
      else if (existing?.builtin) {
        setFormError("Select the built-in format choice from the list.");
        return [];
      } else {
        const ref = `$custom-${refs.length}`;
        operations.push({
          operationId: "custom-format",
          kind: "createFormat",
          ref,
          category: customCategory,
          label: form.customFormat.trim(),
        });
        refs.push(ref);
      }
    }
    return refs;
  };
  const buildNew = async () => {
    const errors: Record<string, string> = {};
    if (!form.title.trim()) errors.title = "Enter a title.";
    Object.assign(
      errors,
      validateMetadataInputs(form.year, form.genre, form.description),
    );
    if (
      form.category === "game" &&
      !form.unknownPlatform &&
      !form.platform.trim()
    )
      errors.platform = "Enter a platform or mark it unknown.";
    if (
      !form.editionId &&
      !form.formatIds.length &&
      !(form.customFormatAdded && form.customFormat.trim())
    ) {
      errors.formats = "Choose at least one physical format.";
    } else if (form.customFormat.trim() && !form.customFormatAdded) {
      errors.customFormat = "Press Add to select this custom format.";
    }
    if (
      form.customFormatAdded &&
      !formatCategoriesFor(form).includes(form.customFormatCategory)
    ) {
      errors.customFormatCategory =
        "Choose a category included in this release.";
    }
    if (form.price.trim() && !form.currency)
      errors.price = "Choose a currency.";
    if (form.price.trim() && !/^\d+(\.\d+)?$/.test(form.price.trim()))
      errors.price = "Enter a non-negative amount.";
    const mainSeasons = parseSeasonInput(form.seasons, form.coverage);
    if (form.category === "tv" && mainSeasons.error)
      errors.seasons = mainSeasons.error;
    for (const [index, c] of (form.contents ?? []).entries()) {
      if (c.category === "tv") {
        const parsed = parseSeasonInput(
          c.seasonsInput ?? c.seasons.join(","),
          c.coverage,
        );
        if (parsed.error) errors[`contents.${index}.seasons`] = parsed.error;
      }
    }
    setFieldErrors(errors);
    if (errors.formats || errors.customFormat || errors.customFormatCategory)
      setFormatChoicesOpen(true);
    if (
      errors.platform ||
      errors.seasons ||
      Object.keys(errors).some((field) => field.startsWith("contents."))
    )
      setAdditionalDetailsOpen(true);
    if (Object.keys(errors).length) {
      setFormError("Fix the highlighted fields to continue.");
      return;
    }
    const ops: Operation[] = [];
    let editionRef: string = form.editionId;
    if (!editionRef) {
      const refs = createFormatOps(ops, [], form.category);
      if (!refs.length) return;
      const workRef = form.workId || "$work";
      if (!form.workId)
        ops.push({
          operationId: "work",
          kind: "createWork",
          ref: workRef,
          category: form.category,
          title: form.title.trim(),
          ...(form.artist.trim() ? { artist: form.artist.trim() } : {}),
          metadata: workMetadataForEditor(undefined, form),
        });
      editionRef = "$edition";
      ops.push({
        operationId: "edition",
        kind: "createEdition",
        ref: editionRef,
        label: form.releaseLabel || null,
        region: form.region || null,
        platform: form.unknownPlatform ? null : form.platform.trim() || null,
        contents: [
          {
            work: workRef,
            coverage: form.category === "tv" ? form.coverage : "not_applicable",
            ...(form.category === "tv" &&
            ["explicit", "complete"].includes(form.coverage)
              ? { seasons: mainSeasons.seasons }
              : {}),
          },
          ...(form.contents ?? []).map((c) => ({
            work: c.work,
            coverage: c.coverage,
            seasons:
              c.category === "tv"
                ? parseSeasonInput(
                    c.seasonsInput ?? c.seasons.join(","),
                    c.coverage,
                  ).seasons
                : c.seasons,
          })),
        ],
        formats: refs,
      });
    }
    ops.push({
      operationId: "copy",
      kind: "createCopy",
      ref: "$copy",
      edition: editionRef,
      ...(form.editionRevision
        ? { expectedEditionRevision: form.editionRevision }
        : {}),
      condition: form.condition,
      shelf: form.shelf || null,
      notes: form.notes || null,
      mediaNotes: form.mediaNotes || null,
      packagingNotes: form.packagingNotes || null,
      ...(form.purchaseDate || form.price || form.retailer
        ? {
            acquisition: {
              date: form.purchaseDate || null,
              amount: form.price || null,
              currency: form.price ? form.currency : null,
              retailer: form.retailer || null,
            },
          }
        : {}),
    });
    await mutation(ops, "Copy");
  };
  const saveEditor = async () => {
    if (editor === "new" || editor === "another") {
      await buildNew();
      return;
    }
    if (editor === "work" && form.workId) {
      const metadataErrors = validateMetadataInputs(
        form.year,
        form.genre,
        form.description,
      );
      if (!form.title.trim()) metadataErrors.title = "Enter a title.";
      setFieldErrors(metadataErrors);
      if (Object.keys(metadataErrors).length) {
        setFormError("Fix the highlighted media details before saving.");
        return;
      }
      if (
        (form.copyCount ?? 0) > 0 &&
        !confirm(
          `This work is used by ${form.copyCount} active copies.\n\nAffected copies:\n${affectedCopyList(form.affectedCopyRefs)}\n\nSave the shared work details for all of them?`,
        )
      )
        return;
      const meta = workMetadataForEditor(form.originalMetadata, form);
      await mutation(
        [
          {
            operationId: "work-update",
            kind: "updateWork",
            id: form.workId,
            expectedRevision: form.workRevision!,
            patch: {
              title: form.title.trim(),
              artist: form.artist || null,
              metadata: meta,
            },
          },
        ],
        "Work",
      );
      return;
    }
    if (editor === "copy" && form.copyId) {
      const reassignment =
        form.targetEditionId && form.targetEditionId !== form.editionId;
      await mutation(
        [
          {
            operationId: "copy-update",
            kind: "updateCopy",
            id: form.copyId,
            expectedRevision: form.copyRevision!,
            ...(reassignment
              ? {
                  expectedSourceEditionRevision: form.sourceEditionRevision,
                  expectedTargetEditionRevision: form.targetEditionRevision,
                }
              : {}),
            patch: {
              ...(reassignment ? { edition: form.targetEditionId } : {}),
              condition: form.condition,
              shelf: form.shelf || null,
              notes: form.notes || null,
              mediaNotes: form.mediaNotes || null,
              packagingNotes: form.packagingNotes || null,
              acquisition: {
                date: form.purchaseDate || null,
                amount: form.price || null,
                currency: form.price ? form.currency : null,
                retailer: form.retailer || null,
              },
            },
          },
        ],
        "Copy",
      );
      return;
    }
    if (editor === "edition" && form.editionId) {
      const errors: Record<string, string> = {};
      if (
        form.category === "game" &&
        !form.unknownPlatform &&
        !form.platform.trim()
      )
        errors.platform = "Enter a platform or mark it unknown.";
      if (form.customFormat.trim() && !form.customFormatAdded)
        errors.customFormat = "Press Add to select this custom format.";
      if (
        form.customFormatAdded &&
        !formatCategoriesFor(form).includes(form.customFormatCategory)
      )
        errors.customFormatCategory =
          "Choose a category included in this release.";
      for (const [index, c] of (form.contents ?? []).entries())
        if (c.category === "tv") {
          const parsed = parseSeasonInput(
            c.seasonsInput ?? c.seasons.join(","),
            c.coverage,
          );
          if (parsed.error) errors[`contents.${index}.seasons`] = parsed.error;
        }
      setFieldErrors(errors);
      if (errors.customFormat || errors.customFormatCategory)
        setFormatChoicesOpen(true);
      if (
        errors.platform ||
        Object.keys(errors).some((field) => field.startsWith("contents."))
      )
        setAdditionalDetailsOpen(true);
      if (Object.keys(errors).length) {
        setFormError("Fix the highlighted fields before saving.");
        return;
      }
      const count = form.copyCount ?? 0;
      if (
        !confirm(
          `This release is shared by ${count} active ${count === 1 ? "copy" : "copies"}.\n\nAffected copies:\n${affectedCopyList(form.affectedCopyRefs)}\n\nSave these changes for all of them?`,
        )
      )
        return;
      const ops: Operation[] = [];
      const fmtRefs = createFormatOps(ops, [], form.category);
      if (!fmtRefs.length) return;
      ops.push({
        operationId: "edition-update",
        kind: "updateEdition",
        id: form.editionId,
        expectedRevision: form.editionRevision!,
        patch: {
          label: form.releaseLabel || null,
          region: form.region || null,
          platform: form.unknownPlatform ? null : form.platform.trim() || null,
          formats: fmtRefs,
          contents: (form.contents ?? []).map((c) => ({
            work: c.work,
            coverage: c.coverage,
            seasons:
              c.category === "tv"
                ? parseSeasonInput(
                    c.seasonsInput ?? c.seasons.join(","),
                    c.coverage,
                  ).seasons
                : c.seasons,
          })),
        },
      });
      await mutation(ops, "Shared release");
    }
  };
  const undoChange = async (id: string) => {
    if (undoInFlight.current.has(id)) return;
    let requestId = undoRequestIds.current.get(id);
    if (!requestId) {
      requestId = newId();
      undoRequestIds.current.set(id, requestId);
    }
    undoInFlight.current.add(id);
    try {
      const r = await window.catalogue.undo(id, requestId);
      if (!r.ok) {
        setToast(
          `Undo unavailable: ${r.error.message}. Retry keeps the same undo request.`,
        );
        return;
      }
      undoRequestIds.current.delete(id);
      setUndo(null);
      setToast("Change undone.");
      await loadWorks(currentFilters());
      if (selectedWork) await reloadCopies();
      if (screen === "statistics" || screen === "collection") {
        const summary = await window.catalogue.statistics();
        if (summary.ok) setStats(summary.value);
        else setToast(summary.error.message);
      }
      if (screen === "settings") {
        const h = await window.catalogue.changesList({ limit: 30 });
        if (h.ok) {
          setHistory(h.value.items);
          setHistoryCursor(h.value.nextCursor);
        } else setToast(h.error.message);
      }
    } catch {
      setToast(
        "Undo result is unknown. Retry to check the same undo request safely.",
      );
    } finally {
      undoInFlight.current.delete(id);
    }
  };
  const deleteSelected = async () => {
    if (!selectedCopies.length) return;
    const rows = selectedCopies
      .map((id) => selectedCopyRefs[id])
      .filter((x): x is CopyRow => !!x);
    if (
      !confirm(
        `Delete ${rows.length === 1 ? "this copy" : "these " + rows.length + " copies"}? The work and shared releases will remain.`,
      )
    )
      return;
    const ops: Operation[] = rows.map((x, i) => ({
      operationId: `delete-${i}`,
      kind: "deleteCopy",
      id: x.id,
      expectedRevision: x.revision,
    }));
    await mutation(ops, "Delete");
  };
  const createBackup = async () => {
    setRecoveryBusy(true);
    setRecoveryStatus("Choose a folder for the backup.");
    try {
      const result = await window.catalogue.createBackup();
      if (!result.ok) {
        setRecoveryStatus(`Backup failed: ${result.error.message}`);
      } else if (result.value.status === "cancelled") {
        setRecoveryStatus("Backup cancelled. The catalogue was not changed.");
      } else {
        const { backup } = result.value;
        setRecoveryStatus(
          `Backup created as “${result.value.bundleName}” with ${backup.totals.workCount} works and ${backup.totals.copyCount} owned copies. Change history is included.`,
        );
      }
    } catch {
      setRecoveryStatus(
        "Backup could not be created. The catalogue was not changed.",
      );
    } finally {
      setRecoveryBusy(false);
    }
  };
  const previewRestore = async () => {
    setRecoveryBusy(true);
    setRecoveryStatus("Choose a backup folder to validate.");
    try {
      const result = await window.catalogue.previewRestore();
      if (!result.ok) {
        setRecoveryStatus(`Backup preview failed: ${result.error.message}`);
      } else if (result.value.status === "cancelled") {
        setRecoveryStatus(
          "Restore cancelled. The current catalogue was not changed.",
        );
      } else {
        setRestorePreview({
          previewToken: result.value.previewToken,
          backup: result.value.backup,
        });
        setRecoveryStatus(
          "Backup validated. Review its contents before restoring.",
        );
      }
    } catch {
      setRecoveryStatus(
        "Backup preview could not be completed. Nothing was restored.",
      );
    } finally {
      setRecoveryBusy(false);
    }
  };
  const dismissRestorePreview = () => {
    if (!restorePreview) return;
    const previewToken = restorePreview.previewToken;
    setRestorePreview(null);
    setRecoveryStatus(
      "Restore cancelled. The current catalogue was not changed.",
    );
    void window.catalogue
      .cancelRestorePreview(previewToken)
      .then((result) => {
        if (!result.ok) {
          setRecoveryStatus(
            `Restore was cancelled, but its temporary preview could not be cleared: ${result.error.message}`,
          );
        }
      })
      .catch(() => {
        setRecoveryStatus(
          "Restore was cancelled, but its temporary preview could not be cleared. It will expire automatically.",
        );
      });
  };
  const confirmRestore = async () => {
    if (!restorePreview) return;
    const selected = restorePreview;
    setRecoveryBusy(true);
    setRecoveryStatus("Restoring the validated backup.");
    try {
      let result;
      try {
        result = await window.catalogue.confirmRestore(selected.previewToken);
      } catch {
        setRestorePreview(null);
        setRecoveryStatus(
          "Restore could not be confirmed. Check the catalogue status before trying again.",
        );
        return;
      }
      setRestorePreview(null);
      if (!result.ok) {
        setRecoveryStatus(`Restore failed: ${result.error.message}`);
        return;
      }
      const { restored } = result.value;
      setRecoveryStatus(
        `Restore complete: ${restored.totals.workCount} works and ${restored.totals.copyCount} owned copies restored. A recoverable backup of the previous catalogue was retained. Integrations must be reconnected.`,
      );

      clearWorkSelection();
      workSelectionSeq.current++;
      editorSeq.current++;
      formatSeq.current++;
      filterFormatSeq.current++;
      workPickerSeq.current++;
      editionPickerSeq.current++;
      setEditor(null);
      setEditorLoading(false);
      setCurrentConflict([]);
      setWorks([]);
      setDisplayedFilterKey("");
      setCursorStack([]);
      setPageCursor(undefined);
      setCursor(null);
      setUndo(null);
      undoRequestIds.current.clear();
      pendingMutation.current = null;
      setFilterOpen(false);
      setFilterFormatLoading(false);
      setAllFormats([]);
      setFormatChoiceCursors({});
      setFilterFormatCursors({});
      setLookups(undefined);
      void loadWorks(currentFilters(), true).catch(() => {
        setStatus(
          "The restored catalogue could not be refreshed. Retry the collection search.",
        );
      });

      try {
        const [refreshedStats, refreshedLookups] = await Promise.all([
          window.catalogue.statistics(),
          window.catalogue.lookups(),
        ]);
        const refreshErrors: string[] = [];
        if (refreshedStats.ok) {
          setStats(refreshedStats.value);
        } else {
          refreshErrors.push(
            `library statistics: ${refreshedStats.error.message}`,
          );
        }
        if (refreshedLookups.ok) {
          setLookups(refreshedLookups.value);
        } else {
          refreshErrors.push(
            `catalogue choices: ${refreshedLookups.error.message}`,
          );
        }
        if (refreshErrors.length) {
          setRecoveryStatus(
            `Restore completed, but ${refreshErrors.join(" and ")} could not be refreshed.`,
          );
        }
      } catch {
        setRecoveryStatus(
          "Restore completed, but catalogue statistics and choices could not be refreshed. Reopen Statistics or Collection to reload them.",
        );
      }
    } catch {
      setRecoveryStatus(
        "Restore completed, but the catalogue view could not be refreshed. Reopen Collection and Statistics to reload them.",
      );
    } finally {
      setRecoveryBusy(false);
    }
  };
  const chosenWork = works.find((x) => x.id === selectedWork);
  const editionForCopy = detail?.type === "owned_copy" ? detail.edition : null;
  const availableFormatCategories = formatCategoriesFor(form);
  const selectedFormatSummary = [
    ...form.formatIds.flatMap((key) => {
      const choice = allFormats.find((format) => formatKey(format) === key);
      return choice
        ? [
            choice.category === form.category
              ? choice.label
              : `${categoryNames[choice.category]} · ${choice.label}`,
          ]
        : [];
    }),
    ...(form.customFormatAdded && form.customFormat.trim()
      ? [form.customFormat.trim()]
      : []),
  ].join(", ");
  const hasAdditionalDetailErrors =
    !!fieldErrors.platform ||
    !!fieldErrors.seasons ||
    Object.keys(fieldErrors).some((field) => field.startsWith("contents."));
  const visibleShelves = collectionShelves(works, collectionView, category);
  const collectionHasFilters = Boolean(
    query.trim() || category || genre.trim() || formatId || from || to,
  );
  const selectedWorkTitle =
    works.find((work) => work.id === selectedWork)?.title ??
    (detail?.type === "work" ? detail.title : "Selected work");
  return (
    <div className="app-root">
      <SidebarProvider defaultOpen>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <div className="brand">
              <ArchivistMark className="brand-mark" />
              <span className="brand-label">Archivist</span>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Catalogue</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={screen === "collection"}
                      aria-current={
                        screen === "collection" ? "page" : undefined
                      }
                      onClick={() => setScreen("collection")}
                      tooltip="Collection"
                    >
                      <Layers />
                      <span>Collection</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={screen === "statistics"}
                      aria-current={
                        screen === "statistics" ? "page" : undefined
                      }
                      onClick={() => setScreen("statistics")}
                      tooltip="Statistics"
                    >
                      <BarChart3 />
                      <span>Statistics</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={screen === "settings"}
                      aria-current={screen === "settings" ? "page" : undefined}
                      onClick={() => setScreen("settings")}
                      tooltip="Settings"
                    >
                      <Settings />
                      <span>Settings</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <span className="sidebar-note">Stored on this device</span>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="main-shell">
          <header className="topbar">
            <SidebarTrigger aria-label="Toggle sidebar" />
            <div className="top-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDark(!dark)}
                aria-label={dark ? "Use light theme" : "Use dark theme"}
              >
                {dark ? <Sun /> : <Moon />}Theme
              </Button>
            </div>
          </header>
          <main className="content">
            {screen === "collection" && (
              <div className="collection-screen">
                <section className="collection-summary">
                  <h1>Your collection</h1>
                  {stats && (
                    <p>
                      {stats.workCount} works · {stats.ownedWorkCount} owned
                      works · {stats.copyCount} owned copies
                    </p>
                  )}
                </section>
                <div className="collection-head">
                  <Tabs
                    value={category ?? "all"}
                    onValueChange={onCategoryValueChange}
                  >
                    <TabsList aria-label="Media category">
                      <TabsTrigger value="all">All</TabsTrigger>
                      {categories.map((c) => (
                        <TabsTrigger key={c} value={c}>
                          {categoryNames[c]}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                  <div className="selection-actions" aria-live="polite">
                    {selectedCopies.length > 0 && (
                      <>
                        <span>{selectedCopies.length} selected</span>
                        <ButtonGroup>
                          <Button
                            variant="outline"
                            onClick={() => {
                              const shelf = prompt(
                                "Set shelf for selected copies",
                              );
                              if (shelf === null) return;
                              const selected = selectedCopies
                                .map((id) => selectedCopyRefs[id])
                                .filter((x): x is CopyRow => !!x);
                              void mutation(
                                selected.map((x, i) => ({
                                  operationId: `shelf-${i}`,
                                  kind: "updateCopy" as const,
                                  id: x.id,
                                  expectedRevision: x.revision,
                                  patch: { shelf: shelf || null },
                                })),
                                "Shelf",
                              );
                            }}
                          >
                            Set shelf
                          </Button>
                          <Button
                            variant="destructive"
                            onClick={() => void deleteSelected()}
                          >
                            <Trash2 />
                            Delete
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => {
                              setSelectedCopies([]);
                              setSelectedCopyRefs({});
                            }}
                          >
                            Clear
                          </Button>
                        </ButtonGroup>
                      </>
                    )}
                  </div>
                </div>
                <div className="collection-tools">
                  <InputGroup>
                    <InputGroupAddon>
                      <Search />
                    </InputGroupAddon>
                    <InputGroupInput
                      aria-label="Search titles"
                      placeholder="Search titles"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        onClick={() => void loadWorks(currentFilters())}
                      >
                        Search
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  <Popover
                    open={filterOpen}
                    onOpenChange={(open) => {
                      setFilterOpen(open);
                      if (open) {
                        const request = ++filterFormatSeq.current;
                        setFilterFormatLoading(true);
                        void Promise.all(
                          categories.map((c) =>
                            window.catalogue.formats({
                              category: c,
                              limit: 100,
                            }),
                          ),
                        ).then((rs) => {
                          if (request !== filterFormatSeq.current) return;
                          setAllFormats(
                            rs.flatMap((r) =>
                              r.ok ? r.value.items.filter((x) => x.id) : [],
                            ),
                          );
                          const cursors: Partial<Record<Category, string>> = {};
                          rs.forEach((r, i) => {
                            if (r.ok && r.value.nextCursor)
                              cursors[categories[i]] = r.value.nextCursor;
                          });
                          setFilterFormatCursors(cursors);
                          setFilterFormatLoading(false);
                          const failed = rs.find((r) => !r.ok);
                          if (failed) setToast(failed.error.message);
                        });
                      } else {
                        filterFormatSeq.current++;
                        setFilterFormatLoading(false);
                      }
                    }}
                  >
                    <PopoverTrigger
                      className={buttonVariants({
                        variant: "outline",
                        className: "shadow-none",
                      })}
                      data-variant="outline"
                      data-size="default"
                    >
                      <SlidersHorizontal />
                      Filters
                    </PopoverTrigger>
                    <PopoverContent align="end" className="filters-popover">
                      <div>
                        <Label htmlFor="filter-genre">Genre</Label>
                        <GenreSelect
                          id="filter-genre"
                          value={genre}
                          onValueChange={setGenre}
                          existingGenres={lookups?.genres ?? []}
                          emptyLabel="Any genre"
                          className="w-full"
                        />
                      </div>
                      <div>
                        <Label htmlFor="filter-format">Physical format</Label>
                        {filterFormatLoading && (
                          <small role="status">Loading formats…</small>
                        )}
                        <Select
                          value={formatId || "all"}
                          onValueChange={(v) =>
                            setFormatId(v === "all" ? "" : v)
                          }
                        >
                          <SelectTrigger id="filter-format">
                            <SelectValue placeholder="Any format" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">Any format</SelectItem>
                            {allFormats
                              .filter((x) => x.id)
                              .map((x) => (
                                <SelectItem key={x.id} value={x.id!}>
                                  {categoryNames[x.category]} · {x.label}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        {Object.entries(filterFormatCursors).map(
                          ([cat, cursor]) => (
                            <Button
                              key={cat}
                              size="sm"
                              variant="ghost"
                              onClick={async () => {
                                const c = cat as Category;
                                const request = filterFormatSeq.current;
                                const pageCursor = filterFormatCursors[c];
                                const r = await window.catalogue.formats({
                                  category: c,
                                  limit: 100,
                                  cursor: pageCursor,
                                });
                                if (
                                  request === filterFormatSeq.current &&
                                  filterOpen &&
                                  filterFormatCursors[c] === pageCursor
                                ) {
                                  if (r.ok) {
                                    setAllFormats((xs) => {
                                      const seen = new Set(xs.map(formatKey));
                                      return [
                                        ...xs,
                                        ...r.value.items.filter(
                                          (x) =>
                                            x.id && !seen.has(formatKey(x)),
                                        ),
                                      ];
                                    });
                                    setFilterFormatCursors((cs) => ({
                                      ...cs,
                                      [c]: r.value.nextCursor ?? undefined,
                                    }));
                                  } else setToast(r.error.message);
                                }
                              }}
                            >
                              More {categoryNames[cat as Category]} formats
                            </Button>
                          ),
                        )}
                      </div>
                      <div className="filter-date">
                        <div>
                          <Label htmlFor="date-from">Purchased from</Label>
                          <Input
                            id="date-from"
                            type="date"
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="date-to">Purchased to</Label>
                          <Input
                            id="date-to"
                            type="date"
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="row">
                        <Button
                          size="sm"
                          onClick={() => {
                            setFilterOpen(false);
                            void loadWorks(currentFilters());
                          }}
                        >
                          Apply filters
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setGenre("");
                            setFormatId("");
                            setFrom("");
                            setTo("");
                          }}
                        >
                          Clear
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Button onClick={() => void beginEditor("new")}>
                    <Plus />
                    Add media
                  </Button>
                  <div
                    className="view-toggle"
                    role="group"
                    aria-label="Collection view"
                  >
                    <Button
                      size="sm"
                      variant={
                        collectionView === "shelves" ? "secondary" : "ghost"
                      }
                      aria-pressed={collectionView === "shelves"}
                      onClick={() => setCollectionView("shelves")}
                    >
                      Shelves
                    </Button>
                    <Button
                      size="sm"
                      variant={
                        collectionView === "grid" ? "secondary" : "ghost"
                      }
                      aria-pressed={collectionView === "grid"}
                      onClick={() => setCollectionView("grid")}
                    >
                      Grid
                    </Button>
                  </div>
                </div>
                {status && (
                  <p role="status" className="muted">
                    {busy ? "Loading…" : status}
                  </p>
                )}
                {!busy && !status && works.length === 0 ? (
                  <section
                    className="collection-empty"
                    aria-labelledby="collection-empty-heading"
                  >
                    <LibraryBig aria-hidden="true" />
                    <h2 id="collection-empty-heading">
                      {collectionHasFilters
                        ? "No matching media"
                        : stats?.workCount === 0
                          ? "Your collection is empty"
                          : "No works found"}
                    </h2>
                    <p>
                      {collectionHasFilters
                        ? "Try changing your search or filters."
                        : "Add a media item to start building your collection."}
                    </p>
                    {collectionHasFilters ? (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setQuery("");
                          setCategory(undefined);
                          setGenre("");
                          setFormatId("");
                          setFrom("");
                          setTo("");
                          setCursorStack([]);
                          setPageCursor(undefined);
                        }}
                      >
                        Clear filters
                      </Button>
                    ) : (
                      <Button onClick={() => void beginEditor("new")}>
                        <Plus />
                        Add media
                      </Button>
                    )}
                  </section>
                ) : (
                  <div className="collection-results">
                    {visibleShelves.map((shelf) => (
                      <section className="collection-shelf" key={shelf.id}>
                        <h2>
                          {category ? categoryNames[category] : shelf.title}
                        </h2>
                        <div
                          className={`catalogue-grid ${collectionView === "shelves" ? "shelf-mode" : "grid-mode"}`}
                        >
                          {shelf.items.map((w) => (
                            <article
                              className={`work-card ${selectedWork === w.id ? "active" : ""}`}
                              key={w.id}
                            >
                              <button
                                className="work-title"
                                aria-expanded={selectedWork === w.id}
                                aria-controls={
                                  selectedWork === w.id
                                    ? "selected-work-copies"
                                    : undefined
                                }
                                onClick={() => {
                                  selectWork(w.id);
                                  void loadDetail("work", w.id);
                                }}
                              >
                                <span
                                  className="work-art"
                                  data-category={w.category}
                                  aria-hidden="true"
                                >
                                  <span className="work-art-category">
                                    {categoryNames[w.category]}
                                  </span>
                                  <LibraryBig className="work-art-icon" />
                                  <strong className="work-art-title">
                                    {w.title}
                                  </strong>
                                  <span className="work-art-missing">
                                    Artwork not available
                                  </span>
                                </span>
                                <span className="work-card-meta">
                                  <strong>{w.title}</strong>
                                  <small>
                                    {categoryNames[w.category]} ·{" "}
                                    {w.copyCount
                                      ? `${w.copyCount} owned ${w.copyCount === 1 ? "copy" : "copies"}`
                                      : "No owned package"}
                                  </small>
                                </span>
                              </button>
                            </article>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
                {selectedWork && (
                  <section
                    className="copy-panel"
                    id="selected-work-copies"
                    aria-labelledby="selected-work-copies-heading"
                  >
                    <div className="copy-panel-heading">
                      <div>
                        <h2 id="selected-work-copies-heading">Owned copies</h2>
                        <p>{selectedWorkTitle}</p>
                      </div>
                      <Button variant="ghost" onClick={clearWorkSelection}>
                        Close
                      </Button>
                    </div>
                    {copyLoading ? (
                      <p role="status">Loading copies…</p>
                    ) : copies.length === 0 ? (
                      <p className="muted">No owned copies for this work.</p>
                    ) : (
                      <div className="copy-list">
                        {copies.map((c) => (
                          <div className="copy-row" key={c.id}>
                            <Checkbox
                              aria-label={copySelectionLabel(
                                c.id,
                                selectedWorkTitle,
                              )}
                              checked={selectedCopies.includes(c.id)}
                              onCheckedChange={(v) => {
                                setSelectedCopies((xs) =>
                                  v === true
                                    ? [...new Set([...xs, c.id])]
                                    : xs.filter((x) => x !== c.id),
                                );
                                setSelectedCopyRefs((rs) => {
                                  const next = { ...rs };
                                  if (v === true) next[c.id] = c;
                                  else delete next[c.id];
                                  return next;
                                });
                              }}
                            />
                            <button
                              onClick={() =>
                                void loadDetail("owned_copy", c.id)
                              }
                            >
                              <b>Copy {c.id.slice(-8)}</b>
                              <span>
                                {c.shelf ? `Shelf ${c.shelf}` : "No shelf"} ·{" "}
                                {conditionNames[c.condition]}
                                {c.purchaseDate
                                  ? ` · bought ${c.purchaseDate}`
                                  : ""}
                              </span>
                            </button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                void beginEditor("copy", "owned_copy", c.id)
                              }
                              aria-label={`Edit copy of ${selectedWorkTitle}`}
                            >
                              <Pencil />
                            </Button>
                          </div>
                        ))}
                        {copyCursor && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              const n = ++copySeq.current;
                              const r = await window.catalogue.copies({
                                workId: selectedWork,
                                limit: 50,
                                cursor: copyCursor,
                              });
                              if (n !== copySeq.current) return;
                              if (r.ok) {
                                setCopies((xs) => [...xs, ...r.value.items]);
                                setCopyCursor(r.value.nextCursor);
                              } else if (r.error.code === "STALE_CURSOR") {
                                await reloadCopies(selectedWork);
                              } else setToast(r.error.message);
                            }}
                          >
                            More copies
                          </Button>
                        )}
                      </div>
                    )}
                  </section>
                )}
                <div className="row page-actions">
                  {cursorStack.length > 0 && (
                    <Button
                      variant="outline"
                      disabled={busy || displayedFilterKey !== filtersKey}
                      onClick={() => {
                        const page = previousPageCursor(
                          cursorStack,
                          pageCursor,
                        );
                        setCursorStack(page.stack);
                        setPageCursor(page.current);
                        void loadWorks(currentFilters(page.current), true);
                      }}
                    >
                      <ChevronLeft />
                      Previous
                    </Button>
                  )}
                  {cursor && (
                    <Button
                      variant="outline"
                      disabled={busy || displayedFilterKey !== filtersKey}
                      onClick={() => {
                        const page = nextPageCursor(
                          cursorStack,
                          pageCursor,
                          cursor,
                        );
                        setCursorStack(page.stack);
                        setPageCursor(page.current);
                        void loadWorks(currentFilters(page.current), true);
                      }}
                    >
                      More works
                      <ChevronRight />
                    </Button>
                  )}
                </div>
                {detail && (
                  <section className="detail-panel">
                    <div className="row">
                      <h2>
                        {detail.type === "work"
                          ? detail.title
                          : detail.type === "owned_copy"
                            ? "Owned copy details"
                            : "Release details"}
                      </h2>
                      <Button variant="ghost" onClick={closeDetail}>
                        Close
                      </Button>
                    </div>
                    {detailLoading ? (
                      "Loading details…"
                    ) : detail.type === "work" ? (
                      <>
                        <p>
                          {categoryNames[detail.category]}
                          {detail.artist ? ` · ${detail.artist}` : ""}
                        </p>
                        <p>
                          {detail.ownedCopyRefs.length
                            ? `${detail.ownedCopyRefs.length} owned copies across shared releases`
                            : "No owned package"}
                        </p>
                        <div className="row">
                          {detail.editionRefs.map((ed) => (
                            <Button
                              key={ed.id}
                              size="sm"
                              variant="outline"
                              onClick={() => void loadDetail("edition", ed.id)}
                            >
                              Open release · revision {ed.revision}
                            </Button>
                          ))}
                        </div>
                        <Button
                          onClick={() =>
                            void beginEditor("work", "work", detail.id)
                          }
                        >
                          Edit work
                        </Button>
                      </>
                    ) : detail.type === "owned_copy" ? (
                      <>
                        <p>
                          Owned copy {detail.record.id} · shelf{" "}
                          {detail.record.shelf || "unknown"} ·{" "}
                          {conditionNames[detail.record.condition]}
                        </p>
                        <p>
                          {editionForCopy?.contents
                            .map((x) => x.work?.title)
                            .filter(Boolean)
                            .join(", ")}
                        </p>
                        <p>
                          {editionForCopy?.formats
                            .map((x) => x.label)
                            .join(", ")}
                        </p>
                        <p>
                          Recorded purchase:{" "}
                          {detail.acquisition?.amount === null ||
                          !detail.acquisition
                            ? "Unknown"
                            : `${detail.acquisition.currency} ${detail.acquisition.amount}`}{" "}
                          · {detail.acquisition?.date || "date unknown"}
                        </p>
                        <div className="row">
                          <Button
                            onClick={() =>
                              void beginEditor(
                                "copy",
                                "owned_copy",
                                detail.record.id,
                              )
                            }
                          >
                            Edit copy
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() =>
                              void beginEditor(
                                "edition",
                                "edition",
                                detail.edition?.record.id,
                              )
                            }
                          >
                            Edit shared release
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() =>
                              void beginEditor(
                                "another",
                                "owned_copy",
                                detail.record.id,
                              )
                            }
                          >
                            Add another copy
                          </Button>
                        </div>
                      </>
                    ) : detail.type === "edition" ? (
                      <>
                        <p>
                          Shared by {detail.ownedCopyRefs.length} active copies
                        </p>
                        <p>
                          {detail.contents
                            .map((x) => x.work?.title)
                            .filter(Boolean)
                            .join(", ")}
                        </p>
                        <p>{detail.formats.map((x) => x.label).join(", ")}</p>
                        <Button
                          onClick={() =>
                            void beginEditor(
                              "edition",
                              "edition",
                              detail.record.id,
                            )
                          }
                        >
                          Edit shared release
                        </Button>
                      </>
                    ) : null}
                  </section>
                )}
              </div>
            )}
            {screen === "statistics" && (
              <>
                <section className="intro">
                  <h1>Library statistics</h1>
                </section>
                {!stats ? (
                  <p role="status">Loading statistics…</p>
                ) : (
                  <>
                    <div className="stat-cards">
                      <Metric label="Works" value={stats.workCount} />
                      <Metric
                        label="Works you own"
                        value={stats.ownedWorkCount}
                      />
                      <Metric label="Owned copies" value={stats.copyCount} />
                      <Metric
                        label="Unpriced copies"
                        value={stats.unpricedCopyCount}
                      />
                      <Metric label="Free copies" value={stats.freeCopyCount} />
                    </div>
                    <section className="grid two">
                      <article className="panel">
                        <h2>Recorded spend</h2>
                        <p className="muted">
                          Original currency totals · unknown prices are
                          excluded.
                        </p>
                        {stats.spendByCurrency.length ? (
                          stats.spendByCurrency.map((x) => (
                            <div className="stat-line" key={x.currency}>
                              <span>{x.currency}</span>
                              <strong>{x.amount}</strong>
                              <small>{x.pricedCopyCount} priced copies</small>
                            </div>
                          ))
                        ) : (
                          <p>No recorded spend yet.</p>
                        )}
                      </article>
                      <article className="panel">
                        <h2>Category memberships</h2>
                        <p className="muted">
                          One copy can appear in more than one category.
                        </p>
                        {categoryMembershipRows(
                          stats.categoryMemberships,
                          categories,
                        ).map(({ category, copyCount }) => (
                          <div className="stat-distribution" key={category}>
                            <div className="stat-line">
                              <span>{categoryNames[category]}</span>
                              <strong>{copyCount} copies</strong>
                            </div>
                            <div className="stat-bar" aria-hidden="true">
                              <span
                                style={{
                                  width: `${stats.copyCount ? (copyCount / stats.copyCount) * 100 : 0}%`,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </article>
                      <article className="panel format-stat">
                        <h2>Physical formats</h2>
                        <p className="muted">
                          A copy with several formats appears in each matching
                          group.
                        </p>
                        <PhysicalFormatChart
                          data={stats.formatMemberships.map((x) => ({
                            format: x.label,
                            count: x.copyCount,
                          }))}
                        />
                      </article>
                    </section>
                  </>
                )}
                <section className="panel settings-panel">
                  <h2>Backup and restore</h2>
                  <p>
                    Create a private backup folder with the catalogue and its
                    change history. Restore accepts the current v2 schema only.
                    Conversations are not included because this schema has no
                    conversation store; credentials are excluded.
                  </p>
                  <p>
                    Record and history IDs are retained, but restore creates a
                    new local catalogue identity; the source collector
                    provenance is not preserved.
                  </p>
                  <p>
                    Restore validates the backup before asking you to confirm.
                    It replaces this catalogue after retaining a recoverable
                    backup of the current one. Integrations must be reconnected
                    after restore.
                  </p>
                  <div className="row">
                    <Button
                      onClick={() => void createBackup()}
                      disabled={recoveryBusy}
                    >
                      Create backup
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void previewRestore()}
                      disabled={recoveryBusy || !!restorePreview}
                    >
                      Choose backup to restore
                    </Button>
                  </div>
                  {recoveryStatus ? (
                    <p className="muted" role="status" aria-live="polite">
                      {recoveryStatus}
                    </p>
                  ) : null}
                </section>
                <Dialog
                  open={!!restorePreview}
                  onOpenChange={(open) => {
                    if (!open && !recoveryBusy) dismissRestorePreview();
                  }}
                >
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Review backup before restore</DialogTitle>
                      <DialogDescription>
                        This validated backup will replace the current catalogue
                        only after you confirm.
                      </DialogDescription>
                    </DialogHeader>
                    {restorePreview ? (
                      <>
                        <dl className="recovery-preview">
                          <div>
                            <dt>Schema compatibility</dt>
                            <dd>
                              Current v{restorePreview.backup.schemaVersion}{" "}
                              schema supported
                            </dd>
                          </div>
                          <div>
                            <dt>Created</dt>
                            <dd>
                              {new Date(
                                restorePreview.backup.createdAt,
                              ).toLocaleString()}
                            </dd>
                          </div>
                          <div>
                            <dt>Works</dt>
                            <dd>{restorePreview.backup.totals.workCount}</dd>
                          </div>
                          <div>
                            <dt>Owned copies</dt>
                            <dd>{restorePreview.backup.totals.copyCount}</dd>
                          </div>
                          <div>
                            <dt>Change history</dt>
                            <dd>
                              {restorePreview.backup.changeHistoryIncluded
                                ? "Included for undo"
                                : "Not included"}
                            </dd>
                          </div>
                          <div>
                            <dt>Conversations</dt>
                            <dd>
                              Not included; the current schema has no
                              conversation store
                            </dd>
                          </div>
                        </dl>
                        <p>
                          The current catalogue will be replaced. A recoverable
                          backup is retained before replacement. Integrations
                          must be reconnected afterward.
                        </p>
                        <p>
                          Record and history IDs remain, but restore creates a
                          new local catalogue identity; source collector and
                          conversation provenance are not preserved.
                        </p>
                        <DialogFooter>
                          <Button
                            variant="outline"
                            onClick={dismissRestorePreview}
                            disabled={recoveryBusy}
                          >
                            Cancel restore
                          </Button>
                          <Button
                            variant="destructive"
                            onClick={() => void confirmRestore()}
                            disabled={recoveryBusy}
                          >
                            {recoveryBusy
                              ? "Restoring…"
                              : "Restore and replace catalogue"}
                          </Button>
                        </DialogFooter>
                      </>
                    ) : null}
                  </DialogContent>
                </Dialog>
              </>
            )}
            {screen === "settings" && (
              <div className="settings-screen">
                <section className="intro">
                  <p className="eyebrow">Preferences and history</p>
                  <h1>Settings</h1>
                </section>
                <div className="settings-columns">
                  <section className="panel settings-panel">
                    <h2>Metadata lookup</h2>
                    <p>
                      Film and TV provider lookup is unavailable until a real
                      provider is configured. You can enter titles manually.
                    </p>
                    <div className="provider-status" role="status">
                      <Sparkles aria-hidden="true" />
                      Provider unavailable
                    </div>
                  </section>
                  <section className="panel settings-panel">
                    <div className="row">
                      <h2>Change history</h2>
                      <Button
                        variant="outline"
                        onClick={async () => {
                          const r = await window.catalogue.changesList({
                            limit: 30,
                          });
                          if (r.ok) {
                            setHistory(r.value.items);
                            setHistoryCursor(r.value.nextCursor);
                          } else setToast(r.error.message);
                        }}
                      >
                        Refresh
                      </Button>
                    </div>
                    {history.length === 0 ? (
                      <p>No catalogue changes yet.</p>
                    ) : (
                      <div className="history-list">
                        {history.map((x) => (
                          <article key={x.id} className="history-row">
                            <div>
                              <b>
                                {humanizeHistoryOperations(x.operations).join(
                                  " · ",
                                ) || "Catalogue change"}
                              </b>
                              <span>
                                {new Date(x.createdAt).toLocaleString()} ·{" "}
                                {x.changeCount} records ·{" "}
                                {x.status === "applied" ? "Applied" : "Undone"}
                              </span>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                const request = ++historyDetailSeq.current;
                                const historyId = x.id;
                                const r = await window.catalogue.changesGet(
                                  historyId,
                                  { limit: 50 },
                                );
                                if (request === historyDetailSeq.current) {
                                  if (r.ok) {
                                    setHistoryDetail(r.value);
                                    setHistoryDetailCursor(r.value.nextCursor);
                                  } else setToast(r.error.message);
                                }
                              }}
                            >
                              Details
                            </Button>
                            {x.status === "applied" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void undoChange(x.id)}
                              >
                                <Undo2 />
                                Undo
                              </Button>
                            )}
                          </article>
                        ))}
                      </div>
                    )}
                    {historyCursor && (
                      <Button
                        variant="outline"
                        onClick={async () => {
                          const r = await window.catalogue.changesList({
                            limit: 30,
                            cursor: historyCursor,
                          });
                          if (r.ok) {
                            setHistory((xs) => [...xs, ...r.value.items]);
                            setHistoryCursor(r.value.nextCursor);
                          } else setToast(r.error.message);
                        }}
                      >
                        More history
                      </Button>
                    )}
                  </section>
                </div>
                {historyDetail && (
                  <section className="panel history-detail">
                    <div className="row">
                      <h2>Change details</h2>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          historyDetailSeq.current++;
                          setHistoryDetail(undefined);
                          setHistoryDetailCursor(null);
                        }}
                      >
                        Close
                      </Button>
                    </div>
                    <p>{historyDetail.changes.length} changed records</p>
                    {historyDetail.changes.map((c) => (
                      <div key={`${c.kind}-${c.id}`} className="history-change">
                        <b>{humanizeHistoryChange(c.operation, c.kind)}</b>
                        <div className="history-diff">
                          <div>
                            <strong>Before</strong>
                            <HistoryProjectionFields value={c.before} />
                          </div>
                          <div>
                            <strong>After</strong>
                            <HistoryProjectionFields value={c.after} />
                          </div>
                        </div>
                      </div>
                    ))}
                    {historyDetailCursor && (
                      <Button
                        variant="outline"
                        onClick={async () => {
                          const request = ++historyDetailSeq.current;
                          const historyId = historyDetail.id;
                          const pageCursor = historyDetailCursor;
                          const r = await window.catalogue.changesGet(
                            historyId,
                            { limit: 50, cursor: pageCursor },
                          );
                          if (
                            request === historyDetailSeq.current &&
                            historyDetail?.id === historyId &&
                            historyDetailCursor === pageCursor
                          ) {
                            if (r.ok) {
                              setHistoryDetail((old) =>
                                old
                                  ? {
                                      ...old,
                                      changes: [
                                        ...old.changes,
                                        ...r.value.changes,
                                      ],
                                    }
                                  : old,
                              );
                              setHistoryDetailCursor(r.value.nextCursor);
                            } else setToast(r.error.message);
                          }
                        }}
                      >
                        More changes
                      </Button>
                    )}
                  </section>
                )}
              </div>
            )}
          </main>
        </SidebarInset>
      </SidebarProvider>
      {toast && (
        <div role="status" className="toast">
          <span>{toast}</span>
          {undo && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void undoChange(undo.changesetId)}
            >
              <Undo2 />
              Undo {undo.label}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setToast("")}
            aria-label="Dismiss message"
          >
            ×
          </Button>
        </div>
      )}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !saving) {
            editorSeq.current++;
            setEditorLoading(false);
            setEditor(null);
          }
        }}
      >
        <DialogContent className="editor-dialog">
          <DialogHeader>
            <DialogTitle>
              {editor === "new"
                ? "Add media"
                : editor === "work"
                  ? "Edit work"
                  : editor === "edition"
                    ? "Edit shared release"
                    : editor === "copy"
                      ? "Edit owned copy"
                      : "Add another copy"}
            </DialogTitle>
            <DialogDescription>
              {editor === "edition"
                ? `Changes to this physical release affect ${form.copyCount ?? 0} active copies.`
                : editor === "work"
                  ? `Changes to this work apply wherever it appears, including ${form.copyCount ?? 0} active copies.`
                  : editor === "copy"
                    ? "Purchase and condition belong to this copy."
                    : "Add the media details you know. Purchase details are optional."}
            </DialogDescription>
          </DialogHeader>
          {editorLoading && <p role="status">Loading record…</p>}
          {!editorLoading && (
            <>
              {(editor === "new" ||
                editor === "work" ||
                editor === "edition" ||
                editor === "another") && (
                <div className="editor-section">
                  <h3>Media details</h3>
                  {editor === "edition" && (
                    <p className="muted">
                      {form.title} · {categoryNames[form.category]}
                      {form.year ? ` · ${form.year}` : ""}
                      {form.genre ? ` · ${form.genre}` : ""}
                    </p>
                  )}
                  {editor === "another" && (
                    <p className="muted">
                      Adding a copy of {form.title} ·{" "}
                      {categoryNames[form.category]}
                      {form.releaseLabel ? ` · ${form.releaseLabel}` : ""}
                    </p>
                  )}
                  {(editor === "new" || editor === "work") && (
                    <Field name="Title (required)" error={fieldErrors.title}>
                      <InputGroup>
                        <InputGroupInput
                          value={form.title}
                          aria-required="true"
                          onChange={(e) => {
                            setF("title", e.target.value);
                            if (editor === "new") {
                              workPickerSeq.current++;
                              editionPickerSeq.current++;
                              workSelectionSeq.current++;
                              setF("workId", "");
                              setF("workRevision", undefined);
                              setF("originalMetadata", undefined);
                              setWorkOptions([]);
                              setWorkPickerCursor(null);
                              setEditionOptions([]);
                              setEditionPickerCursor(null);
                            }
                          }}
                          aria-label="Title"
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            type="button"
                            disabled
                            aria-label="Metadata lookup unavailable"
                            title="Metadata lookup is unavailable until a real provider is configured"
                          >
                            <Sparkles />
                            Unavailable
                          </InputGroupButton>
                        </InputGroupAddon>
                      </InputGroup>
                    </Field>
                  )}
                  <div className="field-grid media-fields">
                    {(editor === "new" || editor === "work") && (
                      <Field name="Category">
                        <Select
                          value={form.category}
                          disabled={editor === "work"}
                          onValueChange={(v) => {
                            workPickerSeq.current++;
                            editionPickerSeq.current++;
                            workSelectionSeq.current++;
                            setF("workId", "");
                            setF("workRevision", undefined);
                            setF("originalMetadata", undefined);
                            setF("customFormatAdded", false);
                            void startFormatChoices(v as Category);
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {categories.map((c) => (
                              <SelectItem key={c} value={c}>
                                {categoryNames[c]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    )}
                    {(editor === "new" || editor === "work") && (
                      <>
                        <Field name="Release year" error={fieldErrors.year}>
                          <Select
                            value={form.year || "__unknown"}
                            onValueChange={(value) =>
                              setF("year", value === "__unknown" ? "" : value)
                            }
                          >
                            <SelectTrigger
                              className="w-full"
                              aria-invalid={Boolean(fieldErrors.year)}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__unknown">Unknown</SelectItem>
                              {releaseYearOptions(form.year).map((year) => (
                                <SelectItem key={year} value={year}>
                                  {year}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field name="Genre" error={fieldErrors.genre}>
                          <GenreSelect
                            id="field-genre"
                            value={form.genre}
                            onValueChange={(value) => setF("genre", value)}
                            existingGenres={lookups?.genres ?? []}
                            emptyLabel="Not set"
                            className="w-full"
                            invalid={Boolean(fieldErrors.genre)}
                            describedBy={
                              fieldErrors.genre
                                ? "field-genre-error"
                                : undefined
                            }
                          />
                        </Field>
                      </>
                    )}
                    {(editor === "new" || editor === "work") &&
                      form.category === "music" && (
                        <Field name="Artist">
                          <Input
                            value={form.artist}
                            onChange={(e) => setF("artist", e.target.value)}
                          />
                        </Field>
                      )}
                  </div>
                  {(editor === "new" || editor === "work") && (
                    <Field name="Description" error={fieldErrors.description}>
                      <Textarea
                        rows={4}
                        maxLength={10000}
                        value={form.description}
                        onChange={(e) => setF("description", e.target.value)}
                        placeholder="Add a description"
                      />
                    </Field>
                  )}
                  {(editor === "new" || editor === "edition") && (
                    <Popover
                      open={formatChoicesOpen}
                      onOpenChange={setFormatChoicesOpen}
                    >
                      <Field
                        name="Formats (required)"
                        error={fieldErrors.formats}
                      >
                        <PopoverTrigger
                          type="button"
                          className={buttonVariants({
                            variant: "outline",
                            className: "format-trigger shadow-none",
                          })}
                          data-variant="outline"
                          data-size="default"
                          aria-label={`Formats (required): ${selectedFormatSummary || "none selected"}`}
                        >
                          <span>
                            {selectedFormatSummary || "Select formats"}
                          </span>
                          <ChevronDown aria-hidden="true" />
                        </PopoverTrigger>
                      </Field>
                      <details
                        className="editor-section additional-media-details"
                        open={
                          additionalDetailsOpen || hasAdditionalDetailErrors
                        }
                        onToggle={(event) =>
                          setAdditionalDetailsOpen(event.currentTarget.open)
                        }
                      >
                        <summary>
                          Additional media details
                          <ChevronDown aria-hidden="true" />
                        </summary>
                        <div className="additional-media-content">
                          <div className="field-grid media-additional-fields">
                            {form.category === "game" && (
                              <>
                                <div className="field">
                                  <Label>Platform</Label>
                                  <label className="row">
                                    <Checkbox
                                      aria-label="Platform is unknown"
                                      checked={form.unknownPlatform}
                                      onCheckedChange={(value) => {
                                        const unknown = value === true;
                                        setF("unknownPlatform", unknown);
                                        if (unknown) setF("platform", "");
                                        setFieldErrors((current) => {
                                          const next = { ...current };
                                          delete next.platform;
                                          return next;
                                        });
                                      }}
                                    />
                                    Unknown platform
                                  </label>
                                </div>
                                <Field
                                  name="Platform"
                                  error={fieldErrors.platform}
                                >
                                  <Input
                                    value={form.platform}
                                    disabled={form.unknownPlatform}
                                    onChange={(e) =>
                                      setF("platform", e.target.value)
                                    }
                                    placeholder="Enter platform"
                                  />
                                </Field>
                              </>
                            )}
                            <Field name="Release label">
                              <Input
                                value={form.releaseLabel}
                                onChange={(e) =>
                                  setF("releaseLabel", e.target.value)
                                }
                              />
                            </Field>
                            <Field name="Region">
                              <Input
                                value={form.region}
                                onChange={(e) => setF("region", e.target.value)}
                              />
                            </Field>
                          </div>
                          {editor === "new" && form.category === "tv" && (
                            <div className="field-grid">
                              <Field name="Season coverage">
                                <Select
                                  value={form.coverage}
                                  onValueChange={(v) =>
                                    setF("coverage", v as CoverageMode)
                                  }
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="unknown">
                                      Unknown
                                    </SelectItem>
                                    <SelectItem value="explicit">
                                      Selected seasons
                                    </SelectItem>
                                    <SelectItem value="complete">
                                      Complete series
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </Field>
                              {(form.coverage === "explicit" ||
                                form.coverage === "complete") && (
                                <Field name="Included seasons">
                                  <Input
                                    value={form.seasons}
                                    aria-invalid={!!fieldErrors.seasons}
                                    aria-describedby={
                                      fieldErrors.seasons
                                        ? "seasons-error"
                                        : undefined
                                    }
                                    onChange={(e) =>
                                      setF("seasons", e.target.value)
                                    }
                                    placeholder="0, 1, 2"
                                  />
                                  <small>
                                    Season 0 is supported. Only enter seasons in
                                    this release.
                                  </small>
                                  {fieldErrors.seasons && (
                                    <small id="seasons-error" role="alert">
                                      {fieldErrors.seasons}
                                    </small>
                                  )}
                                </Field>
                              )}
                            </div>
                          )}
                          {editor === "new" && (
                            <div className="row existing-pickers">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={async () => {
                                  const request = ++workPickerSeq.current;
                                  const queryAtRequest = form.title;
                                  const categoryAtRequest = form.category;
                                  const editorAtRequest = editorSeq.current;
                                  const r = await window.catalogue.picker({
                                    kind: "work",
                                    query: queryAtRequest,
                                    category: categoryAtRequest,
                                    limit: 20,
                                  });
                                  if (
                                    request === workPickerSeq.current &&
                                    editorSeq.current === editorAtRequest &&
                                    formRef.current.title === queryAtRequest &&
                                    formRef.current.category ===
                                      categoryAtRequest
                                  ) {
                                    if (r.ok) {
                                      setWorkOptions(r.value.items);
                                      setWorkPickerCursor(r.value.nextCursor);
                                    } else setToast(r.error.message);
                                  }
                                }}
                              >
                                Find existing work
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={async () => {
                                  const request = ++editionPickerSeq.current;
                                  const queryAtRequest = form.title;
                                  const editorAtRequest = editorSeq.current;
                                  const r = await window.catalogue.picker({
                                    kind: "edition",
                                    query: queryAtRequest,
                                    limit: 20,
                                  });
                                  if (
                                    request === editionPickerSeq.current &&
                                    editorSeq.current === editorAtRequest &&
                                    formRef.current.title === queryAtRequest
                                  ) {
                                    if (r.ok) {
                                      setEditionOptions(r.value.items);
                                      setEditionPickerCursor(
                                        r.value.nextCursor,
                                      );
                                    } else setToast(r.error.message);
                                  }
                                }}
                              >
                                Choose existing release
                              </Button>
                            </div>
                          )}
                          {workOptions.length > 0 && editor === "new" && (
                            <div
                              className="picker-results"
                              aria-label="Existing works"
                            >
                              {workOptions.map((w) => (
                                <Button
                                  key={w.id}
                                  variant={
                                    form.workId === w.id ? "default" : "outline"
                                  }
                                  size="sm"
                                  onClick={async () => {
                                    const request = ++workSelectionSeq.current;
                                    const editorRequest = editorSeq.current;
                                    const workId = w.id;
                                    const r = await window.catalogue.detail(
                                      "work",
                                      workId,
                                    );
                                    if (
                                      request === workSelectionSeq.current &&
                                      editorSeq.current === editorRequest &&
                                      editorRef.current === "new" &&
                                      r.ok &&
                                      r.value.type === "work"
                                    ) {
                                      const d = r.value;
                                      const metadata = metadataEditorValues(
                                        d.metadata,
                                      );
                                      setF("workId", d.id);
                                      setF("workRevision", d.revision);
                                      setF("originalMetadata", d.metadata);
                                      setF("title", d.title);
                                      setF("artist", d.artist ?? "");
                                      setF("category", d.category);
                                      setF("customFormatCategory", d.category);
                                      setF("year", metadata.year);
                                      setF("genre", metadata.genre);
                                      setF("description", metadata.description);
                                      void startFormatChoices(d.category);
                                    }
                                  }}
                                >
                                  {w.title} ·{" "}
                                  {categoryNames[w.category as Category]}
                                </Button>
                              ))}
                              {workPickerCursor && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={async () => {
                                    const request = ++workPickerSeq.current;
                                    const queryAtRequest = form.title;
                                    const categoryAtRequest = form.category;
                                    const pageCursor = workPickerCursor;
                                    const editorAtRequest = editorSeq.current;
                                    const r = await window.catalogue.picker({
                                      kind: "work",
                                      query: queryAtRequest,
                                      category: categoryAtRequest,
                                      limit: 20,
                                      cursor: pageCursor,
                                    });
                                    if (
                                      request === workPickerSeq.current &&
                                      editorSeq.current === editorAtRequest &&
                                      form.title === queryAtRequest &&
                                      form.category === categoryAtRequest &&
                                      workPickerCursor === pageCursor
                                    ) {
                                      if (r.ok) {
                                        setWorkOptions((xs) => [
                                          ...xs,
                                          ...r.value.items.filter(
                                            (item) =>
                                              !xs.some((x) => x.id === item.id),
                                          ),
                                        ]);
                                        setWorkPickerCursor(r.value.nextCursor);
                                      } else setToast(r.error.message);
                                    }
                                  }}
                                >
                                  More results
                                </Button>
                              )}
                            </div>
                          )}
                          {editionOptions.length > 0 && editor === "new" && (
                            <div
                              className="picker-results"
                              aria-label="Existing releases"
                            >
                              {editionOptions.map((e) => (
                                <Button
                                  key={e.id}
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    workSelectionSeq.current++;
                                    setF("editionId", e.id);
                                    setF("editionRevision", e.revision);
                                    setF("title", e.title);
                                    setF("releaseLabel", e.label ?? "");
                                    setEditor("another");
                                  }}
                                >
                                  {e.title}
                                  {e.label ? ` · ${e.label}` : ""} ·{" "}
                                  {e.workCount} works
                                </Button>
                              ))}
                              {editionPickerCursor && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={async () => {
                                    const request = ++editionPickerSeq.current;
                                    const queryAtRequest = form.title;
                                    const pageCursor = editionPickerCursor;
                                    const editorAtRequest = editorSeq.current;
                                    const r = await window.catalogue.picker({
                                      kind: "edition",
                                      query: queryAtRequest,
                                      limit: 20,
                                      cursor: pageCursor,
                                    });
                                    if (
                                      request === editionPickerSeq.current &&
                                      editorSeq.current === editorAtRequest &&
                                      form.title === queryAtRequest &&
                                      editionPickerCursor === pageCursor
                                    ) {
                                      if (r.ok) {
                                        setEditionOptions((xs) => [
                                          ...xs,
                                          ...r.value.items.filter(
                                            (item) =>
                                              !xs.some((x) => x.id === item.id),
                                          ),
                                        ]);
                                        setEditionPickerCursor(
                                          r.value.nextCursor,
                                        );
                                      } else setToast(r.error.message);
                                    }
                                  }}
                                >
                                  More results
                                </Button>
                              )}
                            </div>
                          )}
                          {(editor === "new" || editor === "edition") && (
                            <div className="contents-editor">
                              <div className="row">
                                <Label htmlFor="included-work-query">
                                  Included titles
                                </Label>
                                <Input
                                  id="included-work-query"
                                  value={includedQuery}
                                  onChange={(e) => {
                                    workPickerSeq.current++;
                                    setIncludedQuery(e.target.value);
                                    setIncludedWorkOptions([]);
                                    setIncludedWorkCursor(null);
                                  }}
                                  placeholder="Search works to include"
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={async () => {
                                    const request = ++workPickerSeq.current;
                                    const editorRequest = editorSeq.current;
                                    const queryAtRequest = includedQuery;
                                    const r = await window.catalogue.picker({
                                      kind: "work",
                                      query: queryAtRequest,
                                      limit: 20,
                                    });
                                    if (
                                      request === workPickerSeq.current &&
                                      editorSeq.current === editorRequest &&
                                      includedQueryRef.current ===
                                        queryAtRequest &&
                                      (editor === "new" || editor === "edition")
                                    ) {
                                      if (r.ok) {
                                        setIncludedWorkOptions(r.value.items);
                                        setIncludedWorkCursor(
                                          r.value.nextCursor,
                                        );
                                      } else setToast(r.error.message);
                                    }
                                  }}
                                >
                                  Find works to include
                                </Button>
                              </div>
                              {form.contents?.map((c, index) => {
                                const seasonError =
                                  c.category === "tv"
                                    ? parseSeasonInput(
                                        c.seasonsInput ?? c.seasons.join(","),
                                        c.coverage,
                                      ).error
                                    : undefined;
                                const seasonErrorId = `tv-seasons-error-${index}`;
                                return (
                                  <div className="included-work" key={c.work}>
                                    <b>{c.title ?? c.work}</b>
                                    {c.category === "tv" && (
                                      <>
                                        <Select
                                          value={c.coverage}
                                          onValueChange={(v) =>
                                            setF(
                                              "contents",
                                              (form.contents ?? []).map(
                                                (x, i) =>
                                                  i === index
                                                    ? {
                                                        ...x,
                                                        coverage:
                                                          v as CoverageMode,
                                                      }
                                                    : x,
                                              ),
                                            )
                                          }
                                        >
                                          <SelectTrigger
                                            aria-label={`Coverage for ${c.title ?? "TV work"}`}
                                          >
                                            <SelectValue />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="unknown">
                                              Unknown coverage
                                            </SelectItem>
                                            <SelectItem value="explicit">
                                              Selected seasons
                                            </SelectItem>
                                            <SelectItem value="complete">
                                              Complete series
                                            </SelectItem>
                                          </SelectContent>
                                        </Select>
                                        <Input
                                          aria-label={`Seasons for ${c.title ?? "TV work"}`}
                                          aria-invalid={Boolean(seasonError)}
                                          aria-describedby={
                                            seasonError
                                              ? seasonErrorId
                                              : undefined
                                          }
                                          value={
                                            c.seasonsInput ??
                                            c.seasons.join(",")
                                          }
                                          onChange={(e) =>
                                            setF(
                                              "contents",
                                              (form.contents ?? []).map(
                                                (x, i) =>
                                                  i === index
                                                    ? {
                                                        ...x,
                                                        seasonsInput:
                                                          e.target.value,
                                                      }
                                                    : x,
                                              ),
                                            )
                                          }
                                        />
                                        {seasonError && (
                                          <small
                                            id={seasonErrorId}
                                            role="alert"
                                          >
                                            {seasonError}
                                          </small>
                                        )}
                                      </>
                                    )}
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => {
                                        const contents = (
                                          form.contents ?? []
                                        ).filter((_, i) => i !== index);
                                        setF("contents", contents);
                                        if (
                                          !formatCategoriesFor({
                                            ...form,
                                            contents,
                                          }).includes(form.customFormatCategory)
                                        ) {
                                          setF(
                                            "customFormatCategory",
                                            form.category,
                                          );
                                          setF("customFormatAdded", false);
                                        }
                                      }}
                                    >
                                      Remove
                                    </Button>
                                  </div>
                                );
                              })}
                              {includedWorkOptions.length > 0 &&
                                (editor === "new" || editor === "edition") && (
                                  <div className="picker-results">
                                    {includedWorkOptions.map((w) => (
                                      <Button
                                        key={w.id}
                                        size="sm"
                                        variant="outline"
                                        disabled={
                                          (form.contents ?? []).some(
                                            (c) => c.work === w.id,
                                          ) || form.workId === w.id
                                        }
                                        onClick={() => {
                                          if (!w.category) return;
                                          setF("contents", [
                                            ...(form.contents ?? []),
                                            {
                                              work: w.id,
                                              title: w.title,
                                              category: w.category,
                                              coverage:
                                                w.category === "tv"
                                                  ? "unknown"
                                                  : "not_applicable",
                                              seasons: [],
                                              seasonsInput: "",
                                            },
                                          ]);
                                          void loadFormatChoices(
                                            form.category,
                                            [
                                              ...((form.contents ?? [])
                                                .map((c) => c.category)
                                                .filter(Boolean) as Category[]),
                                              w.category,
                                            ],
                                          );
                                        }}
                                      >
                                        {w.title} ·{" "}
                                        {categoryNames[w.category as Category]}{" "}
                                        — Include
                                      </Button>
                                    ))}
                                    {includedWorkCursor && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={async () => {
                                          const request =
                                            ++workPickerSeq.current;
                                          const queryAtRequest = includedQuery;
                                          const pageCursor = includedWorkCursor;
                                          const editorRequest =
                                            editorSeq.current;
                                          const r =
                                            await window.catalogue.picker({
                                              kind: "work",
                                              query: queryAtRequest,
                                              limit: 20,
                                              cursor: pageCursor,
                                            });
                                          if (
                                            request === workPickerSeq.current &&
                                            editorSeq.current ===
                                              editorRequest &&
                                            includedQueryRef.current ===
                                              queryAtRequest &&
                                            includedWorkCursor === pageCursor
                                          ) {
                                            if (r.ok) {
                                              setIncludedWorkOptions((xs) => [
                                                ...xs,
                                                ...r.value.items.filter(
                                                  (item) =>
                                                    !xs.some(
                                                      (x) => x.id === item.id,
                                                    ),
                                                ),
                                              ]);
                                              setIncludedWorkCursor(
                                                r.value.nextCursor,
                                              );
                                            } else setToast(r.error.message);
                                          }
                                        }}
                                      >
                                        More works
                                      </Button>
                                    )}
                                  </div>
                                )}
                            </div>
                          )}
                        </div>
                      </details>
                      <PopoverContent
                        align="start"
                        className="format-picker"
                        role="group"
                        aria-label="Physical formats"
                      >
                        <div className="format-choice">
                          <p className="sr-only">Choose physical formats</p>
                          <div className="format-options">
                            {allFormats.map((f) => (
                              <label
                                key={`${f.id ?? "new"}-${f.builtinCode ?? f.label}`}
                              >
                                <Checkbox
                                  checked={form.formatIds.includes(
                                    formatKey(f),
                                  )}
                                  onCheckedChange={(v) =>
                                    setF(
                                      "formatIds",
                                      v === true
                                        ? [
                                            ...new Set([
                                              ...form.formatIds,
                                              formatKey(f),
                                            ]),
                                          ]
                                        : form.formatIds.filter(
                                            (x) => x !== formatKey(f),
                                          ),
                                    )
                                  }
                                />
                                {categoryNames[f.category]} · {f.label}
                                {f.builtin ? "" : " · custom"}
                              </label>
                            ))}
                          </div>
                          {Object.entries(formatChoiceCursors).map(([cat]) => (
                            <Button
                              key={cat}
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                void loadMoreEditorFormats(cat as Category)
                              }
                            >
                              More {categoryNames[cat as Category]} formats
                            </Button>
                          ))}
                          <div className="format-custom-fields">
                            <Field
                              name="New format category"
                              error={fieldErrors.customFormatCategory}
                            >
                              <Select
                                value={form.customFormatCategory}
                                onValueChange={(value) => {
                                  setF(
                                    "customFormatCategory",
                                    value as Category,
                                  );
                                  setF("customFormatAdded", false);
                                  setFieldErrors((current) => {
                                    const next = { ...current };
                                    delete next.customFormatCategory;
                                    return next;
                                  });
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {availableFormatCategories.map((value) => (
                                    <SelectItem key={value} value={value}>
                                      {categoryNames[value]}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </Field>
                            <Field
                              name="Custom physical format"
                              error={fieldErrors.customFormat}
                            >
                              <Input
                                value={form.customFormat}
                                onChange={(e) => {
                                  setForm((current) => ({
                                    ...current,
                                    customFormat: e.target.value,
                                    customFormatAdded: false,
                                  }));
                                  setFieldErrors((current) => {
                                    const next = { ...current };
                                    delete next.customFormat;
                                    return next;
                                  });
                                }}
                                placeholder="Add custom format"
                              />
                            </Field>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                const label = form.customFormat.trim();
                                if (!label) {
                                  setFieldErrors((current) => ({
                                    ...current,
                                    customFormat: "Enter a format label.",
                                  }));
                                  return;
                                }
                                const requestCategory =
                                  form.customFormatCategory;
                                const requestEditor = editorSeq.current;
                                const result = await window.catalogue.formats({
                                  category: requestCategory,
                                  exactLabel: label,
                                  limit: 1,
                                });
                                if (
                                  editorSeq.current !== requestEditor ||
                                  formRef.current.customFormatCategory !==
                                    requestCategory ||
                                  formRef.current.customFormat.trim() !== label
                                )
                                  return;
                                if (!result.ok) {
                                  setFieldErrors((current) => ({
                                    ...current,
                                    customFormat: result.error.message,
                                  }));
                                  return;
                                }
                                const match = matchingFormatChoice(
                                  result.value.items,
                                  label,
                                  requestCategory,
                                );
                                setAllFormats((loaded) =>
                                  mergeFormatChoices(
                                    loaded,
                                    result.value.items as FormatRow[],
                                  ),
                                );
                                setFieldErrors((current) => {
                                  const next = { ...current };
                                  delete next.customFormat;
                                  return next;
                                });
                                if (match) {
                                  const key = formatKey(match);
                                  setForm((current) => ({
                                    ...current,
                                    customFormat: "",
                                    customFormatAdded: false,
                                    formatIds: [
                                      ...new Set([...current.formatIds, key]),
                                    ],
                                  }));
                                  setToast(
                                    `${match.builtin ? "Built-in" : "Existing"} format selected.`,
                                  );
                                } else {
                                  setForm((current) => ({
                                    ...current,
                                    customFormat: label,
                                    customFormatAdded: true,
                                  }));
                                }
                              }}
                            >
                              Add
                            </Button>
                          </div>
                          {form.customFormatAdded && (
                            <small role="status">
                              New custom format will be added as a{" "}
                              {categoryNames[form.customFormatCategory]} format.
                            </small>
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              )}
              {editor === "copy" && (
                <section
                  className="editor-section"
                  aria-label="Release reassignment"
                >
                  <h3>Release</h3>
                  <p className="muted">
                    Current release: {form.title}
                    {form.releaseLabel ? ` · ${form.releaseLabel}` : ""}
                  </p>
                  <Label htmlFor="target-release-query">
                    Find a different release for this copy
                  </Label>
                  <div className="row">
                    <Input
                      id="target-release-query"
                      value={targetReleaseQuery}
                      onChange={(e) => {
                        editionPickerSeq.current++;
                        setTargetReleaseQuery(e.target.value);
                        setEditionOptions([]);
                        setEditionPickerCursor(null);
                      }}
                      placeholder="Search releases"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        const request = ++editionPickerSeq.current;
                        const r = await window.catalogue.picker({
                          kind: "edition",
                          query: targetReleaseQuery,
                          limit: 20,
                        });
                        if (request === editionPickerSeq.current) {
                          if (r.ok) {
                            setEditionOptions(r.value.items);
                            setEditionPickerCursor(r.value.nextCursor);
                          } else setToast(r.error.message);
                        }
                      }}
                    >
                      Find release
                    </Button>
                  </div>
                  {editionOptions.map((e) => (
                    <Button
                      key={e.id}
                      size="sm"
                      variant={
                        form.targetEditionId === e.id ? "default" : "outline"
                      }
                      onClick={() => {
                        setF("targetEditionId", e.id);
                        setF("targetEditionRevision", e.revision);
                        setF(
                          "targetEditionTitle",
                          `${e.title}${e.label ? ` · ${e.label}` : ""}`,
                        );
                      }}
                    >
                      {e.title}
                      {e.label ? ` · ${e.label}` : ""} · {e.workCount} works
                    </Button>
                  ))}
                  {editionPickerCursor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const request = ++editionPickerSeq.current;
                        const queryAtRequest = targetReleaseQuery;
                        const pageCursor = editionPickerCursor;
                        const editorRequest = editorSeq.current;
                        const r = await window.catalogue.picker({
                          kind: "edition",
                          query: queryAtRequest,
                          limit: 20,
                          cursor: pageCursor,
                        });
                        if (
                          request === editionPickerSeq.current &&
                          editorSeq.current === editorRequest &&
                          targetReleaseQueryRef.current === queryAtRequest &&
                          editionPickerCursor === pageCursor
                        ) {
                          if (r.ok) {
                            setEditionOptions((xs) => [
                              ...xs,
                              ...r.value.items.filter(
                                (item) => !xs.some((x) => x.id === item.id),
                              ),
                            ]);
                            setEditionPickerCursor(r.value.nextCursor);
                          } else setToast(r.error.message);
                        }
                      }}
                    >
                      More releases
                    </Button>
                  )}
                  {form.targetEditionId &&
                    form.targetEditionId !== form.editionId && (
                      <p className="muted">
                        This copy will move from {form.title} (revision{" "}
                        {form.sourceEditionRevision}) to{" "}
                        {form.targetEditionTitle ?? "the selected release"}{" "}
                        (revision {form.targetEditionRevision}).
                      </p>
                    )}
                </section>
              )}
              {(editor === "new" ||
                editor === "copy" ||
                editor === "another") && (
                <details
                  className="editor-section purchase-section"
                  open={editor === "copy" || !!formError}
                >
                  <summary>
                    Purchase and condition <span>Optional</span>
                    <ChevronDown aria-hidden="true" />
                  </summary>
                  <div className="field-grid">
                    <Field name="Condition">
                      <Select
                        value={form.condition}
                        onValueChange={(v) => setF("condition", v as Condition)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(conditionNames).map(([v, n]) => (
                            <SelectItem key={v} value={v}>
                              {n}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field name="Shelf">
                      <Input
                        value={form.shelf}
                        onChange={(e) => setF("shelf", e.target.value)}
                      />
                    </Field>
                    <Field name="Price" error={fieldErrors.price}>
                      <Input
                        value={form.price}
                        onChange={(e) => setF("price", e.target.value)}
                        inputMode="decimal"
                        placeholder="Unknown"
                      />
                    </Field>
                    <Field name="Currency" error={fieldErrors.currency}>
                      <Select
                        value={form.currency}
                        onValueChange={(v) => setF("currency", v)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {lookups?.currencies.map((x) => (
                            <SelectItem key={x.code} value={x.code}>
                              {x.code}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field
                      name="Purchase date"
                      error={fieldErrors.purchaseDate}
                    >
                      <Input
                        type="date"
                        value={form.purchaseDate}
                        onChange={(e) => setF("purchaseDate", e.target.value)}
                      />
                    </Field>
                    <Field name="Retailer">
                      <Input
                        value={form.retailer}
                        onChange={(e) => setF("retailer", e.target.value)}
                      />
                    </Field>
                    <Field name="Media notes">
                      <Input
                        value={form.mediaNotes}
                        onChange={(e) => setF("mediaNotes", e.target.value)}
                      />
                    </Field>
                    <Field name="Packaging notes">
                      <Input
                        value={form.packagingNotes}
                        onChange={(e) => setF("packagingNotes", e.target.value)}
                      />
                    </Field>
                    <Field name="Notes">
                      <Input
                        value={form.notes}
                        onChange={(e) => setF("notes", e.target.value)}
                      />
                    </Field>
                  </div>
                </details>
              )}
              {formError && (
                <p role="alert" className="form-error">
                  {formError}
                </p>
              )}
              {currentConflict.length > 0 && (
                <section
                  className="conflict-review"
                  aria-label="Current record values"
                >
                  {currentConflict.map((record, index) => {
                    const values =
                      record.type === "work"
                        ? {
                            title: record.title,
                            category: record.category,
                            artist: record.artist,
                            metadata: record.metadata,
                          }
                        : record.type === "edition"
                          ? {
                              label: record.record.label,
                              region: record.record.region,
                              platform: record.record.platform,
                              contents: record.contents,
                              formats: record.formats,
                            }
                          : record.type === "owned_copy"
                            ? {
                                ...record.record,
                                acquisition: record.acquisition,
                              }
                            : record;
                    return (
                      <div
                        key={`${record.type}-${detailIdentity(record)}-${index}`}
                      >
                        <b>
                          Current{" "}
                          {record.type === "owned_copy" ? "copy" : record.type}{" "}
                          values
                        </b>
                        <dl className="facts">
                          {presentChangeFields(values).map((x) => (
                            <React.Fragment key={x.field}>
                              <dt>{x.field}</dt>
                              <dd>{x.value}</dd>
                            </React.Fragment>
                          ))}
                        </dl>
                      </div>
                    );
                  })}
                </section>
              )}
              <div className="row editor-actions">
                <Button
                  variant="outline"
                  onClick={() => {
                    editorSeq.current++;
                    setEditorLoading(false);
                    setEditor(null);
                  }}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button onClick={() => void saveEditor()} disabled={saving}>
                  {saving
                    ? "Saving…"
                    : editor === "new" || editor === "another"
                      ? "Add to collection"
                      : "Save changes"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function Field({
  name,
  children,
  error,
}: {
  name: string;
  children: React.ReactNode;
  error?: string;
}) {
  const id = `field-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const attach = (node: React.ReactNode): React.ReactNode => {
    if (!React.isValidElement(node)) return node;
    const element = node as React.ReactElement<any>;
    const isControl =
      element.type === Input ||
      element.type === InputGroupInput ||
      element.type === Textarea ||
      element.type === Button ||
      element.type === PopoverTrigger ||
      element.type === SelectTrigger;
    const props = isControl
      ? {
          id,
          "aria-invalid": error ? "true" : element.props["aria-invalid"],
          "aria-describedby": error
            ? `${id}-error`
            : element.props["aria-describedby"],
        }
      : {};
    const nested = element.props?.children;
    return React.cloneElement(element, {
      ...props,
      ...(nested !== undefined
        ? { children: React.Children.map(nested, attach) }
        : {}),
    });
  };
  const control = React.Children.map(children, attach);
  return (
    <div className="field">
      <Label htmlFor={id}>{name}</Label>
      {control}
      {error && (
        <small id={`${id}-error`} role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
