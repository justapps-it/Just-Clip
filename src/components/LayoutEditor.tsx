import { useEffect, useRef, useState } from 'react';
import { useI18n, type Key } from '../i18n';
import { FACE_PRESETS, type LayoutSettings, type Rect } from '../lib/layout';
import type { Session } from '../session';
import { layoutFor, saveLayout } from '../settings';

type Box = 'face' | 'game';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Drag-and-resize boxes over a frame of the stream. */
export function LayoutEditor({ session, onClose }: { session: Session; onClose(): void }) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<LayoutSettings>(() => layoutFor(session.layoutKey));
  const [frame, setFrame] = useState<string | null | undefined>(undefined);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ box: Box; mode: 'move' | 'resize'; x: number; y: number; r: Rect } | null>(null);

  useEffect(() => {
    let url: string | null = null;
    session
      .frame()
      .then((u) => setFrame((url = u)))
      .catch(() => setFrame(null));
    return () => {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [session]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      const el = area.current;
      if (!d || !el) return;
      const b = el.getBoundingClientRect();
      const dx = (e.clientX - d.x) / b.width;
      const dy = (e.clientY - d.y) / b.height;
      const r = { ...d.r };
      if (d.mode === 'move') {
        r.x = clamp(d.r.x + dx, 0, 1 - r.w);
        r.y = clamp(d.r.y + dy, 0, 1 - r.h);
      } else {
        r.w = clamp(d.r.w + dx, 0.05, 1 - r.x);
        r.h = clamp(d.r.h + dy, 0.05, 1 - r.y);
      }
      setLayout((l) => ({ ...l, [d.box]: r }));
    };
    const up = () => (drag.current = null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  const start = (box: Box, mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { box, mode, x: e.clientX, y: e.clientY, r: layout[box] };
  };

  const boxStyle = (r: Rect): React.CSSProperties => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

  /** Preview of a source rect scaled to cover a target box (CSS background). */
  const cover = (r: Rect, boxAspect: number): React.CSSProperties => {
    // Source is 16:9; rect aspect in pixels:
    const rectAspect = (r.w * 16) / (r.h * 9);
    let sw = r.w;
    let sh = r.h;
    if (rectAspect > boxAspect) sw = (r.h * 9 * boxAspect) / 16;
    else sh = (r.w * 16) / (9 * boxAspect);
    const sx = r.x + (r.w - sw) / 2;
    const sy = r.y + (r.h - sh) / 2;
    return {
      backgroundImage: frame ? `url(${frame})` : undefined,
      backgroundSize: `${100 / sw}% ${100 / sh}%`,
      backgroundPosition: `${sw < 1 ? (sx / (1 - sw)) * 100 : 0}% ${sh < 1 ? (sy / (1 - sh)) * 100 : 0}%`,
    };
  };

  const topShare = layout.faceShare;
  const cropW = 9 / 16 / (16 / 9); // fraction of source width in a 9:16 crop
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={t('editLayout')}>
      <div className="modal-card layout-editor">
        <div className="modal-head">
          <h2>{t('editLayout')}</h2>
          <div className="seg">
            {(['stack', 'crop'] as const).map((m) => (
              <button key={m} className={layout.vertical === m ? 'on' : ''} onClick={() => setLayout((l) => ({ ...l, vertical: m }))}>
                {m === 'stack' ? t('layoutStack') : t('layoutCrop')}
              </button>
            ))}
          </div>
        </div>
        <p className="small muted">{t('layoutHelp')}</p>
        <div className="layout-grid">
          <div className="frame" ref={area}>
            {frame ? <img src={frame} alt="" draggable={false} /> : <div className="frame-empty muted">{frame === null ? t('noFrame') : t('loading' as Key)}</div>}
            {layout.vertical === 'stack' ? (
              <>
                <div className="box game" style={boxStyle(layout.game)} onPointerDown={start('game', 'move')}>
                  <span>{t('game')}</span>
                  <i onPointerDown={start('game', 'resize')} />
                </div>
                <div className="box face" style={boxStyle(layout.face)} onPointerDown={start('face', 'move')}>
                  <span>{t('facecam')}</span>
                  <i onPointerDown={start('face', 'resize')} />
                </div>
              </>
            ) : (
              <div className="box face" style={{ left: `${layout.cropX * (1 - cropW) * 100}%`, top: 0, width: `${cropW * 100}%`, height: '100%' }} />
            )}
          </div>
          <div className="phone" aria-hidden="true">
            {layout.vertical === 'stack' ? (
              <>
                <div style={{ height: `${topShare * 100}%`, ...cover(layout.face, 9 / (16 * topShare)) }} />
                <div style={{ height: `${(1 - topShare) * 100}%`, ...cover(layout.game, 9 / (16 * (1 - topShare))) }} />
              </>
            ) : (
              <div style={{ height: '100%', ...cover({ x: layout.cropX * (1 - cropW), y: 0, w: cropW, h: 1 }, 9 / 16) }} />
            )}
          </div>
        </div>
        <div className="layout-controls">
          {layout.vertical === 'stack' ? (
            <>
              <div className="row wrap">
                <span className="small muted">{t('presets')}:</span>
                {Object.keys(FACE_PRESETS).map((k) => (
                  <button key={k} className="chip" onClick={() => setLayout((l) => ({ ...l, face: FACE_PRESETS[k] }))}>
                    {t(k as Key)}
                  </button>
                ))}
              </div>
              <label>
                <span className="small">
                  {t('faceShare')} <b>{Math.round(layout.faceShare * 100)}%</b>
                </span>
                <input type="range" min={0.2} max={0.55} step={0.01} value={layout.faceShare} onChange={(e) => setLayout((l) => ({ ...l, faceShare: Number(e.target.value) }))} />
              </label>
            </>
          ) : (
            <label>
              <span className="small">{t('cropX')}</span>
              <input type="range" min={0} max={1} step={0.01} value={layout.cropX} onChange={(e) => setLayout((l) => ({ ...l, cropX: Number(e.target.value) }))} />
            </label>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              saveLayout(session.layoutKey, layout);
              onClose();
            }}
          >
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  );
}
