import type { JSX } from 'solid-js';

type FindingKind = 'missing' | 'ambiguity' | 'contradiction' | 'suggestion';

export function BrandEmblem() {
  return <span class="brand-emblem" aria-hidden="true"><span class="brand-slash"/></span>;
}

export function SectionIndex(props: { number: string; label: string; inverse?: boolean }) {
  return <div class={'section-index' + (props.inverse ? ' section-index-inverse' : '')}>
    <span class="section-index-number">{props.number}</span>
    <span class="section-index-rule" aria-hidden="true"/>
    <span class="section-index-label">{props.label}</span>
  </div>;
}

/** CSS-only poster graphic. No image, font or network dependency. */
export function PosterGeometry() {
  return <div class="poster-geometry" aria-hidden="true">
    <div class="poster-grid"/>
    <div class="poster-disk"/>
    <div class="poster-stripe"/>
    <div class="poster-bar"/>
    <div class="poster-cross">+</div>
    <div class="poster-angle"/>
    <div class="poster-number">01</div>
    <div class="poster-caption">MAKE IT<br/>ACTIONABLE.</div>
  </div>;
}

export function FindingMark(props: { kind: FindingKind }) {
  const mark: Record<FindingKind, string> = {
    missing: '!', ambiguity: '?', contradiction: '×', suggestion: '+',
  };
  return <span class={'finding-icon ' + props.kind} aria-hidden="true">{mark[props.kind]}</span>;
}

export function ScreenLabel(props: { children: JSX.Element; index: string }) {
  return <div class="screen-label"><span class="screen-label-index">{props.index}</span><span>{props.children}</span></div>;
}
