const P: Record<string, string> = {
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  save: 'M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M7 3v5h8V3 M7 21v-7h10v7',
  saveas: 'M5 3h11l3 3v6 M3 5a2 2 0 0 1 2-2 M3 5v14a2 2 0 0 0 2 2h6 M7 3v5h8V3 M7 21v-7h4 M18 15v6 M15 18h6',
  cloud: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
  apps: 'M4 4h4v4H4z M10 4h4v4h-4z M16 4h4v4h-4z M4 10h4v4H4z M10 10h4v4h-4z M16 10h4v4h-4z M4 16h4v4H4z M10 16h4v4h-4z M16 16h4v4h-4z',
  home: 'M3 11l9-8 9 8 M5 10v10h5v-6h4v6h5V10',
  logout:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  undo:'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3',
  cursor: 'M5 3l14 7-6 2-2 6z',
  highlight: 'M9 11l-6 6v3h9l3-3 M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4',
  underline: 'M6 4v7a6 6 0 0 0 12 0V4 M4 21h16',
  strike: 'M16 4H9a3 3 0 0 0-2.83 4 M14 12a4 4 0 0 1 0 8H6 M4 12h16',
  pen: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  shapes: 'M3 3h8v8H3z M17 21a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  note: 'M4 4h16v11l-5 5H4z M15 20v-5h5',
  text: 'M4 6V4h16v2 M12 4v16 M9 20h6',
  edittext: 'M4 7V5h12v2 M10 5v9 M8 14h4 M13 21l3-1 6-6-2-2-6 6z',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21',
  form: 'M4 4h16v16H4z M8 12l3 3 5-6',
  sign: 'M3 17c3-6 5-9 7-9s0 8 3 8 2-5 4-5 2 3 4 3 M3 21h18',
  pages: 'M7 3h9l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M15 3v5h5 M9 13h7 M9 17h5',
  zoomin: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3 M11 8v6 M8 11h6',
  zoomout: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3 M8 11h6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3',
  rotl: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5',
  rotr: 'M21 12a9 9 0 1 1-3-6.7L21 8 M21 3v5h-5',
  trash: 'M3 6h18 M8 6V4h8v2 M6 6l1 14h10l1-14 M10 10v6 M14 10v6',
  addpage: 'M6 2h9l5 5v15H6z M14 2v6h6 M12 12v6 M9 15h6',
  extract: 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
  merge: 'M4 4h7v7H4z M13 13h7v7h-7z M11 7.5h4a2 2 0 0 1 2 2V13',
  split: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M20 4L8.1 15.9 M14.5 14.5L20 20 M8.1 8.1L12 12',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  close: 'M18 6L6 18 M6 6l12 12',
  fitw: 'M4 12h16 M8 8l-4 4 4 4 M16 8l4 4-4 4',
  rect: 'M4 5h16v14H4z',
  ellipse: 'M12 5c5 0 9 3 9 7s-4 7-9 7-9-3-9-7 4-7 9-7z',
  line: 'M5 19L19 5',
  arrow: 'M5 19L19 5 M10 5h9v9',
  textfield: 'M3 7h18v10H3z M7 10v4',
  checkbox: 'M5 5h14v14H5z M8.5 12l2.5 2.5 4.5-5',
  dropdown: 'M3 7h18v10H3z M14 11l2.5 2.5L19 11',
  type: 'M5 7V4h14v3 M12 4v16 M9 20h6',
  check: 'M5 12l5 5L20 7',
  eraser: 'M20 20H9l-5-5a2 2 0 0 1 0-2.8l9-9a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8L12 20 M7 11l6 6',
  update: 'M21 12a9 9 0 1 1-2.6-6.4 M21 3v6h-6 M12 8v5 M9.5 11l2.5 2.5 2.5-2.5',
};

export function icon(name: string): string {
  return `<svg viewBox="0 0 24 24">${P[name].split(' M').map((d, i) => `<path d="${i ? 'M' : ''}${d}"/>`).join('')}</svg>`;
}

export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('i[data-icon]').forEach((el) => {
    if (!el.firstChild) el.innerHTML = icon(el.dataset.icon!);
  });
}
