import { useEffect, useState } from "react";
import { presentChangeFields } from "./catalogue-ui-helpers";

/** Resolve history's opaque relation IDs to explicitly current, potentially changed labels. */
export function HistoryProjectionFields({ value }: { value: unknown }) {
  const [fields, setFields] = useState<Array<{ field: string; value: string }>>(
    [],
  );

  useEffect(() => {
    let active = true;
    const resolve = async () => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        setFields(presentChangeFields(value));
        return;
      }
      const projection = value as Record<string, unknown>;
      const contents = Array.isArray(projection.contents)
        ? projection.contents
        : undefined;
      const formats = Array.isArray(projection.formats)
        ? projection.formats
        : undefined;
      const workIds = [
        ...new Set(
          (contents ?? []).flatMap((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
              return [];
            const workId = (item as Record<string, unknown>).workId;
            return typeof workId === "string" ? [workId] : [];
          }),
        ),
      ];
      const formatIds = [
        ...new Set(
          (formats ?? []).filter(
            (item): item is string => typeof item === "string",
          ),
        ),
      ];
      const workLabels = new Map<string, string>();
      const formatLabels = new Map<string, string>();
      await Promise.all([
        ...workIds.map(async (id) => {
          try {
            const result = await window.catalogue.detail("work", id);
            if (result.ok && result.value.type === "work")
              workLabels.set(id, result.value.title);
          } catch {
            /* The durable projection remains useful when a referenced record was removed. */
          }
        }),
        ...formatIds.map(async (id) => {
          try {
            const result = await window.catalogue.detail("format", id);
            if (result.ok && result.value.type === "format")
              formatLabels.set(id, result.value.label);
          } catch {
            /* Show that the recorded ID has no readable current label. */
          }
        }),
      ]);
      const resolved = {
        ...projection,
        ...(contents
          ? {
              contents: contents.map((item) => {
                if (!item || typeof item !== "object" || Array.isArray(item))
                  return item;
                const row = item as Record<string, unknown>;
                const id = typeof row.workId === "string" ? row.workId : "";
                return {
                  ...row,
                  ...(id
                    ? {
                        currentWorkTitle:
                          workLabels.get(id) ?? "Work label unavailable",
                      }
                    : {}),
                };
              }),
            }
          : {}),
        ...(formats && formatIds.length
          ? {
              formats: formats.map((item) =>
                typeof item === "string"
                  ? {
                      currentFormatLabel:
                        formatLabels.get(item) ?? "Format label unavailable",
                    }
                  : item,
              ),
            }
          : {}),
      };
      if (active) setFields(presentChangeFields(resolved));
    };
    void resolve();
    return () => {
      active = false;
    };
  }, [value]);

  return fields.length ? (
    <>
      {fields.map((item) => (
        <p key={item.field}>
          <span>{item.field}</span> {item.value}
        </p>
      ))}
    </>
  ) : (
    <p>No recorded value</p>
  );
}
