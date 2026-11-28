const paths = {
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4 4"/>',
  files: '<path d="M7 3H3v14m6-11h7l4 4v11H8V6h1Zm7 0v5h4"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6m-6 4h6"/>',
  filePlus: '<path d="M6 3h8l4 4v14H6zM14 3v5h4m-6 3v7m-3.5-3.5h7"/>',
  folder: '<path d="M3 6h7l2 2h9v12H3z"/>',
  folderOpen: '<path d="M3 19V5h7l2 3h8v3M3 19l3-8h16l-3 8z"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7.5 9 3 3-3 3m6 0h3"/>',
  settings: '<path d="m10 3-.8 2.4-2 .9-2.4-.8-2 3.4 1.8 1.7v2.6l-1.8 1.7 2 3.4 2.4-.8 2 .9L10 21h4l.8-2.6 2-.9 2.4.8 2-3.4-1.8-1.7v-2.6l1.8-1.7-2-3.4-2.4.8-2-.9L14 3z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="m8 5 12 7-12 7z" fill="currentColor" stroke-linejoin="round"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.3" fill="currentColor"/>',
  refresh: '<path d="M19 11a7 7 0 0 0-12-5l-3 3m0-5v5h5m-4 4a7 7 0 0 0 12 5l3-3m0 5v-5h-5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  stepIn: '<path d="M12 4v13m-5-5 5 5 5-5M6 21h12"/>',
  stepOut: '<path d="M12 17V4m-5 5 5-5 5 5M6 21h12"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zm-8 4.5 8 4.5 8-4.5M12 12v9m-4-15.7 8 4.5"/>',
  save: '<path d="M5 3h13l3 3v15H3V3zm2 0v6h10V3M7 21v-8h10v8"/>',
  format: '<path d="m4 7 2 2 4-5m3 3h7M4 13h16M4 19h12"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  trash: '<path d="M4 6h16M6 6l1 14h10l1-14M9 6V3h6v3m-5 4v6m4-6v6"/>',
  branch: '<circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="7" r="2"/><path d="M7 7v10M7 15c0-5 10 0 10-6"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  warning: '<path d="M12 3 2 20h20zM12 9v4m0 3h.01"/>',
  hammer: '<path d="m14 4 6 6-2 2-2-2-8 9-3-3 9-8-2-2z"/>',
  flask: '<path d="M9 3h6m-1 0v7l6 9a1 1 0 0 1-1 2H5a1 1 0 0 1-1-2l6-9V3M7 15h10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  command: '<path d="m6 7 5 5-5 5m8 0h5"/>',
} as const;

export type Icon = keyof typeof paths;

export function icon(name: Icon): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

export function fileIcon(path: string): string {
  if (path.endsWith(".go")) return '<span class="file-icon go-file" aria-hidden="true">Go</span>';
  const name = path.split("/").at(-1);
  if (name === "go.mod" || name === "go.work" || name === "go.sum") return `<span class="file-icon mod-file">${icon("package")}</span>`;
  if (/\.md$/i.test(path)) return `<span class="file-icon md-file">${icon("info")}</span>`;
  return `<span class="file-icon generic-file">${icon("file")}</span>`;
}

export function prepareIcons() {
  for (const element of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    element.innerHTML = icon(element.dataset.icon as Icon);
  }
}
