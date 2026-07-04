const htmlEscapes = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

export function escapeAttr(value) {
  return escapeHtml(value);
}

export function valueToText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function columnNames(resultSet) {
  const fromColumns = Array.isArray(resultSet?.columns)
    ? resultSet.columns.map((column) => Object.keys(column || {})[0]).filter(Boolean)
    : [];

  if (fromColumns.length > 0) return fromColumns;

  const firstRow = Array.isArray(resultSet?.data) ? resultSet.data[0] : null;
  return firstRow ? Object.keys(firstRow) : [];
}

export function urlWithParams(pathname, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}
