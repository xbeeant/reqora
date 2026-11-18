import { uid } from "./id.ts";

const PREFIX = "__add_row__";

export interface RowEditState<T> {
  items: readonly T[];
  /** React key of the trailing "add" row, which is local state, not an item. */
  placeholderId: string;
}

export interface RowEditResult<T> {
  items: T[];
  placeholderId: string;
}

/** A fresh, collision-free key for the trailing add-row. */
export function newPlaceholderId(exclude: readonly string[] = []): string {
  let id = `${PREFIX}${uid()}`;
  while (exclude.includes(id)) id = `${PREFIX}${uid()}`;
  return id;
}

/**
 * Apply one cell edit in a key/value table and return the items to persist plus
 * the add-row key to keep in local state.
 *
 * The important part: when the edited id is not in `items`, it is the add-row
 * being promoted to a real row. It MUST keep the same id. If we hand it a new
 * id, React keeps the old (now empty) input mounted and moves it to the end,
 * so the caret lands back on an empty add-row and every following keystroke
 * creates another one-character parameter ("type" → "t", "y", "p", "e").
 * Reusing the id keeps the focused DOM node at the same position; we then
 * rotate the *add-row* to a fresh key.
 *
 * Matching by "is this id already an item?" instead of comparing with
 * `placeholderId` also covers the async file-picker case, where the recorded
 * add-row id may have rotated since the picker was opened.
 */
export function applyRowEdit<T extends { id: string }>(
  state: RowEditState<T>,
  id: string,
  patch: Partial<T>,
  createRow: (id: string) => T,
): RowEditResult<T> {
  if (state.items.some((item) => item.id === id)) {
    return {
      items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      placeholderId: state.placeholderId,
    };
  }
  const items: T[] = [...state.items, { ...createRow(id), ...patch }];
  return { items, placeholderId: newPlaceholderId(items.map((item) => item.id)) };
}
