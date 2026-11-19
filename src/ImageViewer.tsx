import { useCallback, useEffect, useRef } from 'react';
import type { CapResult } from './pipeline/types';
import type { Region } from './scanner';

export type Mark = { cap: CapResult; kind: 'match' | 'uncertain' | 'similar' | 'all' };

interface Props {
  bitmap: ImageBitmap;
  /** Scanned part of the photo; the rest is dimmed. Null when the whole photo was scanned. */
  region: Region | null;
  marks: Mark[];
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const COLORS = { match: '#16a34a', uncertain: '#d97706', similar: '#d97706', all: '#2563eb' };

/** Photo viewer with pinch/drag/wheel zoom and circle highlights drawn in image space. */
export function ImageViewer({ bitmap, region, marks }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; mid: { x: number; y: number }; view: View } | null>(null);
  const lastTap = useRef(0);
  const marksRef = useRef(marks);
  marksRef.current = marks;

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
    const ctx = c.getContext('2d')!;
    const { scale, tx, ty } = view.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0);

    const px = 1 / scale; // one screen pixel in image units
    if (region) {
      ctx.beginPath();
      ctx.rect(0, 0, bitmap.width, bitmap.height);
      ctx.rect(region.x, region.y, region.width, region.height);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2 * px;
      ctx.strokeRect(region.x, region.y, region.width, region.height);
    }
    // Dim everything except matches when there are search highlights.
    const hl = marksRef.current.filter((m) => m.kind !== 'all');
    if (hl.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, bitmap.width, bitmap.height);
      for (const m of hl) {
        ctx.moveTo(m.cap.cx + m.cap.r * 1.25, m.cap.cy);
        ctx.arc(m.cap.cx, m.cap.cy, m.cap.r * 1.25, 0, Math.PI * 2, true);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill('evenodd');
      ctx.restore();
    }
    for (const m of marksRef.current) {
      const { cx, cy, r } = m.cap;
      const color = COLORS[m.kind];
      const isAll = m.kind === 'all';
      ctx.lineWidth = (isAll ? 2 : 5) * px;
      ctx.setLineDash(m.kind === 'uncertain' || m.kind === 'similar' ? [10 * px, 6 * px] : []);
      if (!isAll) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 9 * px;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 5 * px;
      }
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (isAll ? 1 : 1.25), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      const label = m.kind === 'similar' ? `${m.cap.code}?` : m.kind === 'uncertain' ? `${m.cap.code}?` : (m.cap.code ?? '');
      if (!label) continue;
      const fs = (isAll ? 12 : 16) * px;
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      const lx = cx - tw / 2;
      const ly = cy - r * (isAll ? 1 : 1.25) - 6 * px;
      ctx.fillStyle = color;
      ctx.fillRect(lx - 4 * px, ly - fs, tw + 8 * px, fs + 6 * px);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx, ly);
    }
  }, [bitmap, region]);

  /** Fit the scanned area (or the whole photo) to the view. */
  const fit = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const { x, y, width, height } = region ?? { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
    const s = Math.min(8, c.clientWidth / width, c.clientHeight / height);
    view.current = { scale: s, tx: (c.clientWidth - width * s) / 2 - x * s, ty: (c.clientHeight - height * s) / 2 - y * s };
  }, [bitmap, region]);

  const minScale = () => {
    const c = canvasRef.current!;
    return Math.min(c.clientWidth / bitmap.width, c.clientHeight / bitmap.height) * 0.9;
  };

  const zoomAt = (x: number, y: number, factor: number, from: View = view.current) => {
    const s = Math.max(minScale(), Math.min(8, from.scale * factor));
    const k = s / from.scale;
    view.current = { scale: s, tx: x - (x - from.tx) * k, ty: y - (y - from.ty) * k };
  };

  // Fit on new image; redraw on resize.
  useEffect(() => {
    fit();
    draw();
    const c = canvasRef.current!;
    const ro = new ResizeObserver(() => draw());
    ro.observe(c);
    return () => ro.disconnect();
  }, [bitmap, fit, draw]);

  useEffect(() => draw(), [marks, draw]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    startGesture();
    if (pointers.current.size === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        const p = local(e);
        zoomAt(p.x, p.y, 2);
        draw();
        lastTap.current = 0;
      } else lastTap.current = now;
    }
  };

  const startGesture = () => {
    const pts = [...pointers.current.values()];
    const mid = pts.length === 2 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    const dist = pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { dist, mid, view: { ...view.current } };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, local(e));
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    if (pts.length === 1) {
      view.current = { ...g.view, tx: g.view.tx + pts[0].x - g.mid.x, ty: g.view.ty + pts[0].y - g.mid.y };
    } else if (pts.length === 2 && g.dist > 0) {
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      zoomAt(g.mid.x, g.mid.y, dist / g.dist, g.view);
      view.current.tx += mid.x - g.mid.x;
      view.current.ty += mid.y - g.mid.y;
    }
    draw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) startGesture();
    else gesture.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = local(e);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    draw();
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
        onWheel={onWheel}
        aria-label="Photo of markers with search highlights"
      />
      <div className="viewer-controls">
        <button type="button" aria-label="Zoom in" onClick={() => { const c = canvasRef.current!; zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1.6); draw(); }}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => { const c = canvasRef.current!; zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1 / 1.6); draw(); }}>−</button>
        <button type="button" aria-label={region ? 'Fit scanned area' : 'Fit photo'} onClick={() => { fit(); draw(); }}>⤢</button>
      </div>
    </div>
  );
}
