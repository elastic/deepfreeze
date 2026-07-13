import { EuiDescriptionList, type EuiBasicTableColumn } from '@elastic/eui';
import type { ReactNode } from 'react';

/**
 * Render a single item as a vertical description list using the SAME column
 * definitions a table uses. Each column becomes one row: the column `name` is
 * the title and the column's own `render(value, item)` produces the
 * description. Because it reuses the table's render functions, the values shown
 * in a flyout are guaranteed identical to the corresponding list cells (same
 * badges, health indicators, date formatting, computed fields, etc.).
 */
export default function ColumnsDescriptionList<T extends Record<string, unknown>>({
  columns,
  item,
}: {
  columns: EuiBasicTableColumn<T>[];
  item: T;
}) {
  const listItems = columns
    .filter((col) => 'field' in col && col.name)
    .map((col) => {
      const field = (col as { field: keyof T }).field;
      const value = item[field];
      const rendered: ReactNode =
        typeof (col as { render?: unknown }).render === 'function'
          ? (col as { render: (v: unknown, i: T) => ReactNode }).render(value, item)
          : (value as ReactNode);
      // EuiDescriptionList requires non-null title/description.
      const description: NonNullable<ReactNode> = rendered ?? '--';
      return { title: String((col as { name: ReactNode }).name), description };
    });

  return <EuiDescriptionList type="column" compressed listItems={listItems} />;
}
