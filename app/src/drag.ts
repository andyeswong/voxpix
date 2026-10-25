// Ventanas flotantes que se mueven (v-draggable="'nombre'"): se arrastran por su cabecera (<header>), sin salirse de
// la ventana; la posición se recuerda (localStorage) y un doble clic en la cabecera las devuelve a su sitio.
//
// Y se apartan de los menús: nunca quedan encima de lo marcado con data-repel (las barras de arriba y de abajo y los
// menús desplegados). Si al arrastrar o al abrirse un menú se solapan, la ventana se desplaza lo mínimo para dejarlo
// libre (con la propiedad CSS `translate`, que se suma a su posición sin tocarla), y cuando el menú se cierra vuelve
// a su sitio.
import type { Directive } from 'vue';

const KEY = (name: string) => `voxpix.ventana.${name}`;
const MARGIN = 8;       // con el borde de la pantalla
const GAP = 8;          // con los menús
// La ventana que se toca pasa al frente (por encima también de las píldoras de arriba, que van a z 5)
let front = 6;

const windows = new Set<HTMLElement>();

function place(el: HTMLElement, left: number, top: number): void {
  const r = base(el);
  const x = Math.max(MARGIN, Math.min(innerWidth - r.width - MARGIN, left));
  const y = Math.max(MARGIN, Math.min(innerHeight - Math.min(r.height, 60) - MARGIN, top));
  Object.assign(el.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto', transform: 'none' });
}

// El sitio de la ventana sin el desplazamiento con el que se aparta: el de maquetación (offset*), que no incluye
// `translate` ni la animación de volver
function base(el: HTMLElement): DOMRect {
  return new DOMRect(el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight);
}

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

// El sitio libre más cercano: candidatos pegados a los bordes de cada menú (combinando x de uno e y de otro), dentro
// de la pantalla y sin pisar ninguno. Si no hay ninguno libre, el que menos pisa.
function push(rect: DOMRect, obstacles: DOMRect[]): [number, number] {
  const hits = (r: DOMRect) => obstacles.reduce((n, o) => n + (overlaps(r, o) ? 1 : 0), 0);
  if (!hits(rect)) return [0, 0];
  const w = rect.width, h = rect.height;
  const xs = [rect.left, ...obstacles.flatMap((o) => [o.left - w, o.right])];
  const ys = [rect.top, ...obstacles.flatMap((o) => [o.top - h, o.bottom])];
  const maxTop = Math.max(MARGIN, innerHeight - Math.min(h, 60) - MARGIN);
  let best: [number, number] = [0, 0], bestScore = Infinity;
  for (const x of xs) for (const y of ys) {
    if (x < MARGIN || x + w > innerWidth - MARGIN || y < MARGIN || y > maxTop) continue;
    const r = new DOMRect(x, y, w, h);
    const score = hits(r) * 1e6 + Math.hypot(x - rect.left, y - rect.top);
    if (score < bestScore) { bestScore = score; best = [x - rect.left, y - rect.top]; }
  }
  return best;
}

function relayout(): void {
  const obstacles = Array.from(document.querySelectorAll<HTMLElement>('[data-repel]'))
    .filter((o) => o.offsetParent !== null || getComputedStyle(o).position === 'fixed')
    .map((o) => { const r = o.getBoundingClientRect(); return new DOMRect(r.left - GAP, r.top - GAP, r.width + 2 * GAP, r.height + 2 * GAP); })
    .filter((r) => r.width > 2 * GAP && r.height > 2 * GAP);
  for (const el of windows) {
    if (!el.isConnected) continue;
    const [dx, dy] = push(base(el), obstacles);
    const now = el.dataset.push ?? '0,0', next = `${Math.round(dx)},${Math.round(dy)}`;
    if (now === next) continue;
    el.dataset.push = next;
    el.style.translate = dx || dy ? `${Math.round(dx)}px ${Math.round(dy)}px` : '';
  }
}

let queued = 0;
export function scheduleRelayout(): void {
  cancelAnimationFrame(queued);
  queued = requestAnimationFrame(relayout);
}

// Los menús que se abren y cierran, y las ventanas que se pliegan, cambian el sitio libre: se mira en cuanto pasa
if (typeof window !== 'undefined') {
  new MutationObserver(scheduleRelayout).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', scheduleRelayout);
}

function load(name: string): { left: number; top: number } | null {
  try { const v = localStorage.getItem(KEY(name)); return v ? JSON.parse(v) : null; } catch { return null; }
}
function store(name: string, pos: { left: number; top: number } | null): void {
  try { if (pos) localStorage.setItem(KEY(name), JSON.stringify(pos)); else localStorage.removeItem(KEY(name)); } catch { /* sin almacenamiento */ }
}

export const vDraggable: Directive<HTMLElement & { _dragOff?: () => void }, string> = {
  mounted(el, binding) {
    const name = binding.value;
    windows.add(el);
    el.classList.add('repels');
    const saved = load(name);
    requestAnimationFrame(() => { if (saved) place(el, saved.left, saved.top); scheduleRelayout(); });
    let start: { x: number; y: number; left: number; top: number } | null = null;
    const handle = () => el.querySelector('header') as HTMLElement | null;
    const onHandle = (e: MouseEvent) => {
      const h = handle();
      return !!h && h.contains(e.target as Node) && !(e.target as HTMLElement).closest('button, input, select, label');
    };

    const down = (e: MouseEvent) => {
      el.style.zIndex = String(++front);
      if (e.button !== 0 || !onHandle(e)) return;
      e.preventDefault();
      const r = base(el);
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      el.classList.add('dragging');
    };
    const move = (e: MouseEvent) => {
      if (!start) return;
      place(el, start.left + e.clientX - start.x, start.top + e.clientY - start.y);
      relayout();                      // mientras se arrastra, se aparta al momento
    };
    const up = () => {
      if (!start) return;
      start = null;
      el.classList.remove('dragging');
      // Se guarda donde ha quedado de verdad (si un menú la empujó, ahí)
      const r = el.getBoundingClientRect();
      el.dataset.push = '0,0';
      el.style.translate = '';
      place(el, r.left, r.top);
      store(name, { left: r.left, top: r.top });
      scheduleRelayout();
    };
    // Doble clic en la cabecera: a su sitio de siempre (el que da el CSS)
    const reset = (e: MouseEvent) => {
      if (!onHandle(e)) return;
      Object.assign(el.style, { left: '', top: '', right: '', bottom: '', transform: '' });
      store(name, null);
      scheduleRelayout();
    };
    // Si la ventana del navegador encoge, que no se quede fuera
    const resize = () => { if (load(name)) { const r = base(el); place(el, r.left, r.top); } };
    const ro = new ResizeObserver(scheduleRelayout);
    ro.observe(el);

    el.addEventListener('mousedown', down);
    el.addEventListener('dblclick', reset);
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
    addEventListener('resize', resize);
    el._dragOff = () => {
      windows.delete(el);
      ro.disconnect();
      el.removeEventListener('mousedown', down);
      el.removeEventListener('dblclick', reset);
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      removeEventListener('resize', resize);
    };
  },
  unmounted(el) { el._dragOff?.(); },
};
