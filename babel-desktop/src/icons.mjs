const iconPaths = {
  plus:'<path d="M12 5v14M5 12h14"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  down:'<path d="m5 9 7 7 7-7"/>',
  folder:'<path d="M3 6a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>',
  folderOpen:'<path d="M3 18V5h6l3 3h8v3M3 18l3-7h16l-3 9H4Z"/>',
  file:'<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5"/>',
  readme:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h6M8 16h5"/>',
  code:'<path d="M6 3h8l4 4v14H6Z"/><path d="m10 11-2 2 2 2m4-4 2 2-2 2M14 3v5h4"/>',
  new:'<path d="M13 3H6v18h12V9M13 3v6h6M16 2v6M13 5h6"/>',
  search:'<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/>',
  test:'<path d="m12 2 9 10-9 10L3 12Z"/><path d="M12 2v20M3 12h18"/>',
  git:'<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 7c0 5-12 5-12 10"/>',
  settings:'<path d="m10 3-.7 2.4-2.2 1.3L4.6 6 3 9l1.8 1.7v2.6L3 15l1.6 3 2.5-.7 2.2 1.3L10 21h4l.7-2.4 2.2-1.3 2.5.7 1.6-3-1.8-1.7v-2.6L21 9l-1.6-3-2.5.7-2.2-1.3L14 3Z"/><circle cx="12" cy="12" r="3"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  wrench:'<path d="m14 7 3 3 4-4a6 6 0 0 1-8 8l-7 7-3-3 7-7a6 6 0 0 1 8-8Z"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
  stop:'<rect x="6" y="6" width="12" height="12" rx="1"/>',
  refresh:'<path d="M20 7V2l-4 4a8 8 0 1 0 4 9M20 7h-6"/>',
  external:'<path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7"/>',
  terminal:'<path d="m4 6 6 6-6 6M13 18h7"/>',
  shield:'<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z"/><path d="m8 12 3 3 5-6"/>'
};
export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] ?? iconPaths.file}</svg>`;
}
