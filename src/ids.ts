export function stableId(value: string): string {
  const slug = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/g, '');
  return slug || 'change';
}
