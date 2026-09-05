// The plain-text emails could pass a stranger's name and message through
// untouched, because text cannot be markup. In HTML it can.
export function escapeHtml(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
