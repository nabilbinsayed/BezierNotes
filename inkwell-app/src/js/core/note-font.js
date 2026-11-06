/**
 * The typeface for text notes, shared by every place that draws or measures
 * one. The PDF writer draws saved notes from these same fonts
 * (inkwell-core/src/text_shape.rs), so what you type is what other readers
 * show: Inter for Latin/Greek/Cyrillic, Noto Sans Bengali for Bangla.
 */
export const NOTE_FONT_FAMILY = 'Inter, "Noto Sans Bengali", system-ui, -apple-system, sans-serif';

/** Canvas `font` shorthand for a note. */
export function noteFont(size, bold = false, italic = false) {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${NOTE_FONT_FAMILY}`;
}

/**
 * Canvas text only uses a web font once it has loaded; until then notes fall
 * back to a system face. Load the note faces up front and call `onReady`
 * so already-drawn pages can be repainted with the right glyphs.
 */
export function preloadNoteFonts(onReady) {
  if (typeof document === 'undefined' || !document.fonts?.load) return;
  const faces = ['400 16px Inter', '700 16px Inter', 'italic 400 16px Inter', 'italic 700 16px Inter',
    '400 16px "Noto Sans Bengali"', '700 16px "Noto Sans Bengali"'];
  Promise.all(faces.map(f => document.fonts.load(f, 'অa')))
    .then(() => onReady && onReady())
    .catch(err => console.warn('[inkwell] note fonts failed to load:', err));
}
