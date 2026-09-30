import { describe, expect, it, vi } from "vitest";
import { CatalogueError } from "../src/core/catalogue/contracts";
import { registerCatalogueIpc } from "../src/main/catalogue-ipc";

describe("catalogue backup and restore IPC", () => {
  it("keeps selected paths in the main process through preview, cancel and confirmed restore", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<any>>();
    let backupParent: string | undefined;
    let restoreBundle: string | undefined;
    const calls: string[] = [];
    const manifest = {
      formatVersion: 1,
      createdAt: "2026-09-29T12:00:00.000Z",
      schemaVersion: 2,
      totals: {
        catalogueRevision: 3,
        workCount: 2,
        ownedWorkCount: 1,
        copyCount: 1,
        pricedCopyCount: 0,
        unpricedCopyCount: 1,
        freeCopyCount: 0,
        spendByCurrency: [],
      },
      inclusions: {
        catalogue: true,
        changeHistory: true,
        conversations: false,
        credentials: false,
        sessions: false,
        runtimeAuthority: false,
      },
    };
    const runtime = {
      createBackup: vi.fn(async (directory: string) => {
        calls.push(`create:${directory}`);
        return manifest;
      }),
      previewBackup: vi.fn(async (directory: string) => {
        calls.push(`preview:${directory}`);
        return {
          formatVersion: 1,
          createdAt: manifest.createdAt,
          schemaVersion: 2,
          totals: manifest.totals,
          changeHistoryIncluded: true as const,
          conversationsIncluded: false as const,
        };
      }),
      restoreBackup: vi.fn(async (directory: string) => {
        calls.push(`restore:${directory}`);
        return {
          currentBackupDirectory: "/private/synthetic/current-catalogue",
          manifest,
        };
      }),
    };
    registerCatalogueIpc(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      () => true,
      () => runtime as any,
      () => undefined,
      {
        chooseBackupParent: async () => backupParent,
        chooseRestoreBundle: async () => restoreBundle,
      },
    );
    const invoke = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({}, ...args);

    backupParent = undefined;
    expect(await invoke("catalogue:backup:create")).toEqual({
      ok: true,
      value: { status: "cancelled" },
    });
    restoreBundle = undefined;
    expect(await invoke("catalogue:restore:preview")).toEqual({
      ok: true,
      value: { status: "cancelled" },
    });
    expect(runtime.createBackup).not.toHaveBeenCalled();
    expect(runtime.previewBackup).not.toHaveBeenCalled();
    expect(await invoke("catalogue:backup:create", "/synthetic/path")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(await invoke("catalogue:restore:preview", "/synthetic/path")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });

    backupParent = "/synthetic/backup-parent";
    const created = await invoke("catalogue:backup:create");
    expect(created.ok).toBe(true);
    expect(created.value.status).toBe("created");
    expect(created.value.backup.schemaVersion).toBe(2);
    expect(created.value.backup.changeHistoryIncluded).toBe(true);
    expect(JSON.stringify(created)).not.toContain(backupParent);
    expect(calls[0]).toMatch(/^create:\/synthetic\/backup-parent\/Archivist backup /);

    restoreBundle = "/synthetic/restore-bundle";
    const preview = await invoke("catalogue:restore:preview");
    expect(preview.ok).toBe(true);
    expect(preview.value.status).toBe("ready");
    expect(preview.value.backup.totals.workCount).toBe(2);
    expect(JSON.stringify(preview)).not.toContain(restoreBundle);
    expect(runtime.restoreBackup).not.toHaveBeenCalled();

    const cancelledPreview = await invoke(
      "catalogue:restore:cancel-preview",
      preview.value.previewToken,
    );
    expect(cancelledPreview).toEqual({ ok: true, value: { cancelled: true } });
    const cancelledConfirm = await invoke(
      "catalogue:restore:confirm",
      preview.value.previewToken,
    );
    expect(cancelledConfirm.ok).toBe(false);
    expect(runtime.restoreBackup).not.toHaveBeenCalled();

    const readyPreview = await invoke("catalogue:restore:preview");
    const completion = await invoke(
      "catalogue:restore:confirm",
      readyPreview.value.previewToken,
    );
    expect(completion.ok).toBe(true);
    expect(completion.value.previousCatalogueRecoverable).toBe(true);
    expect(completion.value.restored.totals.workCount).toBe(2);
    expect(JSON.stringify(completion)).not.toContain("/private/synthetic/current-catalogue");
    expect(calls).toContain(`restore:${restoreBundle}`);
  });

  it("returns safe validation errors without exposing selected paths", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<any>>();
    const runtime = {
      createBackup: vi.fn(),
      previewBackup: vi.fn(async () => {
        throw new Error("private path /synthetic/malformed-backup");
      }),
      restoreBackup: vi.fn(),
    };
    registerCatalogueIpc(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      () => true,
      () => runtime as any,
      () => undefined,
      {
        chooseBackupParent: async () => undefined,
        chooseRestoreBundle: async () => "/synthetic/malformed-backup",
      },
    );
    const result = await handlers.get("catalogue:restore:preview")!({});
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("APP_UNAVAILABLE");
    expect(result.error.message).not.toContain("/synthetic/malformed-backup");
    expect(result.error.message).not.toContain("private path");

    runtime.previewBackup.mockRejectedValueOnce(
      new CatalogueError("RESTORE_INVALID", "Backup contents are invalid."),
    );
    const safeFailure = await handlers.get("catalogue:restore:preview")!({});
    expect(safeFailure.ok).toBe(false);
    expect(safeFailure.error.code).toBe("RESTORE_INVALID");
    expect(safeFailure.error.message).toBe("Backup contents are invalid.");
  });
});
