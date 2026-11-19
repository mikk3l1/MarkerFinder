import { useCallback, useEffect, useRef } from 'react';
import type { Region } from './scanner';

interface Props {
  bitmap: ImageBitmap;
  region: Region;
  onChange: (r: Region) => void;
}

/** Edges a drag moves. All false = move the whole rectangle. */
interface Grip {
  l: boolean;
  r: boolean;
  t: boolean;
  b: boolean;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Drag =
  | { kind: 'grip'; grip: Grip; start: { x: number; y: number }; box: Box }
  | { kind: 'new'; anchor: { x: number; y: number } };

/** Grab distance for corners and edges, in screen pixels. */
const GRIP_PX = 24;
/** Smallest selection, in screen pixels. */
const MIN_PX = 40;

const toBox = (r: Region): Box => ({ x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });

/** Photo fitted to the view with a draggable selection rectangle (image coordinates). */
export function CropView({ bitmap, region, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fitRef = useRef({ s: 1, ox: 0, oy: 0 });
  const drag = useRef<Drag | null>(null);
  const regionRef = useRef(region);
  regionRef.current = region;

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    // Leave room around the photo so edge handles can be grabbed.
    const pad = 16;
    const s = Math.min((w - 2 * pad) / bitmap.width, (h - 2 * pad) / bitmap.height);
    const ox = (w - bitmap.width * s) / 2;
    const oy = (h - bitmap.height * s) / 2;
    fitRef.current = { s, ox, oy };

    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, ox, oy, bitmap.width * s, bitmap.height * s);

    const r = regionRef.current;
    const rx = ox + r.x * s;
    const ry = oy + r.y * s;
    const rw = r.width * s;
    const rh = r.height * s;

    ctx.beginPath();
    ctx.rect(ox, oy, bitmap.width * s, bitmap.height * s);
    ctx.rect(rx, ry, rw, rh);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    // Rule-of-thirds guides help judge the selection.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      ctx.moveTo(rx + rw * f, ry);
      ctx.lineTo(rx + rw * f, ry + rh);
      ctx.moveTo(rx, ry + rh * f);
      ctx.lineTo(rx + rw, ry + rh * f);
    }
    ctx.stroke();

    // Corner handles.
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    const L = Math.min(22, rw / 3, rh / 3);
    for (const [cx, cy, dx, dy] of [
      [rx, ry, 1, 1],
      [rx + rw, ry, -1, 1],
      [rx, ry + rh, 1, -1],
      [rx + rw, ry + rh, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * L, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * L);
      ctx.stroke();
    }
  }, [bitmap]);

  useEffect(() => {
    draw();
    const c = canvasRef.current!;
    const ro = new ResizeObserver(() => draw());
    ro.observe(c);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => draw(), [region, draw]);

  /** Pointer position in image coordinates (unclamped). */
  const toImage = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { s, ox, oy } = fitRef.current;
    return { x: (e.clientX - rect.left - ox) / s, y: (e.clientY - rect.top - oy) / s };
  };

  const commit = (b: Box) => {
    const W = bitmap.width;
    const H = bitmap.height;
    const x0 = Math.round(Math.max(0, Math.min(W, Math.min(b.x0, b.x1))));
    const x1 = Math.round(Math.max(0, Math.min(W, Math.max(b.x0, b.x1))));
    const y0 = Math.round(Math.max(0, Math.min(H, Math.min(b.y0, b.y1))));
    const y1 = Math.round(Math.max(0, Math.min(H, Math.max(b.y0, b.y1))));
    onChange({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (drag.current) return; // one pointer at a time
    e.preventDefault(); // don't start a text selection while dragging
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toImage(e);
    const box = toBox(regionRef.current);
    const g = GRIP_PX / fitRef.current.s;
    const nearX0 = Math.abs(p.x - box.x0) < g;
    const nearX1 = Math.abs(p.x - box.x1) < g;
    const nearY0 = Math.abs(p.y - box.y0) < g;
    const nearY1 = Math.abs(p.y - box.y1) < g;
    const inX = p.x > box.x0 - g && p.x < box.x1 + g;
    const inY = p.y > box.y0 - g && p.y < box.y1 + g;
    // Prefer the nearer edge when the selection is small enough for both to be in reach.
    const l = nearX0 && inY && (!nearX1 || Math.abs(p.x - box.x0) <= Math.abs(p.x - box.x1));
    const r = nearX1 && inY && !l;
    const t = nearY0 && inX && (!nearY1 || Math.abs(p.y - box.y0) <= Math.abs(p.y - box.y1));
    const b = nearY1 && inX && !t;
    const inside = p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1;
    if (l || r || t || b || inside) drag.current = { kind: 'grip', grip: { l, r, t, b }, start: p, box };
    else drag.current = { kind: 'new', anchor: p };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toImage(e);
    const W = bitmap.width;
    const H = bitmap.height;
    const min = MIN_PX / fitRef.current.s;
    if (d.kind === 'new') {
      const a = { x: Math.max(0, Math.min(W, d.anchor.x)), y: Math.max(0, Math.min(H, d.anchor.y)) };
      const q = { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
      if (Math.abs(q.x - a.x) < min || Math.abs(q.y - a.y) < min) return;
      commit({ x0: a.x, y0: a.y, x1: q.x, y1: q.y });
      return;
    }
    const { grip, start, box } = d;
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (!grip.l && !grip.r && !grip.t && !grip.b) {
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      const x0 = Math.max(0, Math.min(W - w, box.x0 + dx));
      const y0 = Math.max(0, Math.min(H - h, box.y0 + dy));
      commit({ x0, y0, x1: x0 + w, y1: y0 + h });
      return;
    }
    const next = { ...box };
    if (grip.l) next.x0 = Math.max(0, Math.min(box.x1 - min, box.x0 + dx));
    if (grip.r) next.x1 = Math.min(W, Math.max(box.x0 + min, box.x1 + dx));
    if (grip.t) next.y0 = Math.max(0, Math.min(box.y1 - min, box.y0 + dy));
    if (grip.b) next.y1 = Math.min(H, Math.max(box.y0 + min, box.y1 + dy));
    commit(next);
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div className="viewer">
      <canvas
        ref={canvasRef}
        className="viewer-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-label="Photo with the area to scan selected. Drag the corners or edges to change it, or drag outside it to draw a new area."
      />
    </div>
  );
}
