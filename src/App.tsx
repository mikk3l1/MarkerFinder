import { useEffect, useMemo, useRef, useState } from 'react';
import { CropView } from './CropView';
import { ImageViewer, type Mark } from './ImageViewer';
import type { CapResult } from './pipeline/types';
import { decodeImage, fullRegion, isFullRegion, Scanner, type Region, type ScanProgress } from './scanner';
import { searchResults } from './search';

type Phase =
  | { kind: 'empty' }
  | { kind: 'cropping' }
  | { kind: 'scanning'; progress: ScanProgress | null }
  | { kind: 'ready'; results: CapResult[] }
  | { kind: 'error'; message: string };

const STAGE_LABEL = { load: 'Loading recognition models…', detect: 'Finding marker caps…', ocr: 'Reading codes' };

export default function App() {
  const scanner = useRef<Scanner | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  /** Area of the photo to scan, in bitmap pixels. */
  const [region, setRegion] = useState<Region | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'empty' });
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [showAll, setShowAll] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  // Download and initialize the recognition engines while the user takes or picks a photo.
  useEffect(() => {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
    scanner.current ??= new Scanner();
    scanner.current.preload();
  }, []);

  const runScan = async (bmp: ImageBitmap, area: Region) => {
    scanner.current ??= new Scanner();
    setPhase({ kind: 'scanning', progress: null });
    try {
      const results = await scanner.current.scan(bmp, area, (progress) => setPhase({ kind: 'scanning', progress }));
      setPhase({ kind: 'ready', results });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bmp = await decodeImage(file);
      bitmap?.close();
      setBitmap(bmp);
      setRegion(fullRegion(bmp));
      setSubmitted('');
      setShowAll(false);
      setPhase({ kind: 'cropping' });
    } catch {
      setPhase({ kind: 'error', message: 'This file could not be opened as an image. Use a JPEG, PNG or WebP photo.' });
    }
  };

  const results = phase.kind === 'ready' ? phase.results : null;
  const cropped = !!bitmap && !!region && !isFullRegion(region, bitmap);
  const search = useMemo(() => (results && submitted ? searchResults(results, submitted) : null), [results, submitted]);

  const marks: Mark[] = useMemo(() => {
    if (!results) return [];
    if (search) {
      return [
        ...search.similar.map((cap) => ({ cap, kind: 'similar' as const })),
        ...search.uncertain.map((cap) => ({ cap, kind: 'uncertain' as const })),
        ...search.confirmed.map((cap) => ({ cap, kind: 'match' as const })),
      ];
    }
    return showAll ? results.filter((r) => r.status === 'confirmed').map((cap) => ({ cap, kind: 'all' as const })) : [];
  }, [results, search, showAll]);

  const counts = useMemo(() => {
    if (!results) return null;
    return {
      confirmed: results.filter((r) => r.status === 'confirmed').length,
      uncertain: results.filter((r) => r.status === 'uncertain').length,
    };
  }, [results]);

  useEffect(() => {
    if (phase.kind === 'ready') searchInput.current?.focus();
  }, [phase.kind]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(query);
    searchInput.current?.blur();
  };

  const pct = phase.kind === 'scanning' && phase.progress?.stage === 'ocr' ? Math.round((phase.progress.done / Math.max(1, phase.progress.total)) * 100) : null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>Marker Finder</h1>
        {bitmap && (
          <div className="topbar-actions">
            <NewPhotoMenu onCamera={() => cameraInput.current?.click()} onFiles={() => fileInput.current?.click()} />
            {phase.kind !== 'cropping' && (
              <>
                <button type="button" className="btn-ghost" onClick={() => setPhase({ kind: 'cropping' })}>
                  Crop
                </button>
                <button type="button" className="btn-ghost" disabled={phase.kind === 'scanning'} onClick={() => bitmap && region && void runScan(bitmap, region)}>
                  Rescan
                </button>
              </>
            )}
          </div>
        )}
      </header>

      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/*" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />

      {!bitmap && (
        <main className="intro">
          <p className="lead">Take a photo of your markers from above, then type the code you are looking for.</p>
          <div className="intro-actions">
            <button type="button" className="btn-primary" onClick={() => cameraInput.current?.click()}>
              Take photo
            </button>
            <button type="button" className="btn-secondary" onClick={() => fileInput.current?.click()}>
              Choose photo
            </button>
          </div>
          <ul className="tips">
            <li>Shoot straight down so the caps face the camera.</li>
            <li>Use even light and avoid glare on the caps.</li>
            <li>Get close enough that the codes are sharp. Several photos of parts of a large set work better than one blurry photo.</li>
          </ul>
          <p className="privacy">Your photo is processed on this device and never uploaded.</p>
          {phase.kind === 'error' && <p className="msg msg-error">{phase.message}</p>}
        </main>
      )}

      {bitmap && region && phase.kind === 'cropping' && (
        <main className="workspace">
          <div className="cropbar">
            <p>Drag to select the part of the photo to search. A smaller area scans faster.</p>
            <div className="cropbar-actions">
              <button type="button" className="btn-secondary" disabled={!cropped} onClick={() => setRegion(fullRegion(bitmap))}>
                Whole photo
              </button>
              <button type="button" className="btn-primary" onClick={() => void runScan(bitmap, region)}>
                Scan {cropped ? 'area' : 'photo'}
              </button>
            </div>
          </div>
          <CropView bitmap={bitmap} region={region} onChange={setRegion} />
        </main>
      )}

      {bitmap && region && phase.kind !== 'cropping' && (
        <main className="workspace">
          <form className="searchbar" onSubmit={onSearch}>
            <input
              ref={searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value.toUpperCase())}
              placeholder="Marker code, e.g. BG3"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              aria-label="Marker code"
              disabled={phase.kind !== 'ready'}
            />
            <button type="submit" className="btn-primary" disabled={phase.kind !== 'ready' || !query.trim()}>
              Find
            </button>
          </form>

          <Status phase={phase} pct={pct} search={search} counts={counts} cropped={cropped} showAll={showAll} onToggleAll={() => setShowAll((v) => !v)} />

          <ImageViewer bitmap={bitmap} region={cropped ? region : null} marks={marks} />
        </main>
      )}
    </div>
  );
}

/** "New photo" button with a menu: take a photo with the camera or choose one from storage. */
function NewPhotoMenu({ onCamera, onFiles }: { onCamera: () => void; onFiles: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstItem.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // The file input must be opened from the click itself (user gesture), so call it before closing.
  const pick = (open: () => void) => {
    open();
    setOpen(false);
  };

  return (
    <div className="menu-root" ref={root}>
      <button ref={button} type="button" className="btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        New photo
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="New photo">
          <button ref={firstItem} type="button" role="menuitem" onClick={() => pick(onCamera)}>
            Take photo
          </button>
          <button type="button" role="menuitem" onClick={() => pick(onFiles)}>
            Choose photo
          </button>
        </div>
      )}
    </div>
  );
}

function Status({
  phase,
  pct,
  search,
  counts,
  cropped,
  showAll,
  onToggleAll,
}: {
  phase: Phase;
  pct: number | null;
  search: ReturnType<typeof searchResults> | null;
  counts: { confirmed: number; uncertain: number } | null;
  cropped: boolean;
  showAll: boolean;
  onToggleAll: () => void;
}) {
  if (phase.kind === 'scanning') {
    const label = phase.progress ? STAGE_LABEL[phase.progress.stage] : 'Starting…';
    return (
      <div className="status" role="status" aria-live="polite">
        <div className="status-line">
          {label}
          {pct !== null && ` ${pct}%`}
        </div>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${pct ?? 3}%` }} />
        </div>
      </div>
    );
  }
  if (phase.kind === 'error') return <p className="msg msg-error">Recognition failed: {phase.message}. Try Rescan.</p>;
  if (phase.kind !== 'ready' || !counts) return null;

  if (counts.confirmed + counts.uncertain === 0) {
    return (
      <p className="msg msg-warn" role="status">
        No marker codes were recognized{cropped ? ' in the selected area' : ''}. Try a sharper photo, taken closer and straight from above, in even light.
      </p>
    );
  }

  if (!search) {
    return (
      <p className="msg" role="status">
        Read {counts.confirmed} codes{counts.uncertain > 0 && ` (+${counts.uncertain} uncertain)`}.{' '}
        <button type="button" className="link" onClick={onToggleAll}>
          {showAll ? 'Hide' : 'Show'} recognized codes
        </button>
      </p>
    );
  }

  const { query, validQuery, confirmed, uncertain, similar } = search;
  if (!validQuery) {
    return (
      <p className="msg msg-warn" role="status">
        “{query}” is not an Ohuhu code. Codes look like BG3, Y131 or YR313.
      </p>
    );
  }
  if (confirmed.length > 0) {
    return (
      <p className="msg msg-ok" role="status">
        Found {query}
        {confirmed.length > 1 ? ` (${confirmed.length} markers)` : ''}.
        {uncertain.length + similar.length > 0 && ' Dashed circles are possible matches.'}
      </p>
    );
  }
  if (uncertain.length > 0 || similar.length > 0) {
    const alt = [...new Set(similar.map((s) => s.code))].join(', ');
    return (
      <p className="msg msg-warn" role="status">
        {query} was not found with certainty.{' '}
        {uncertain.length > 0 ? `${uncertain.length} possible match${uncertain.length > 1 ? 'es' : ''} (dashed)` : ''}
        {uncertain.length > 0 && similar.length > 0 ? '; ' : ''}
        {similar.length > 0 ? `caps read as ${alt} could be ${query}` : ''}. Zoom in to check.
      </p>
    );
  }
  return (
    <p className="msg msg-warn" role="status">
      {query} was not found in {cropped ? 'the selected area' : 'this photo'}. Its code may be hidden, blurry or covered by another marker.
    </p>
  );
}
