// The desk's theme: neutral greys and one accent until a palette is picked. Colours live in styles.css as variables.
import { studioTheme } from 'ag-studio'

export const deskTheme = studioTheme.withParams({
  fontFamily: 'var(--rt-font)',
  textColor: 'var(--rt-text)',
  foregroundColor: 'var(--rt-text)',
  backgroundColor: 'var(--rt-surface)',
  borderColor: 'var(--rt-border)',
  accentColor: 'var(--rt-accent)',
  subtleTextColor: 'var(--rt-dim)',
  chartPaletteFills1Color: 'var(--rt-accent)',
  chartPaletteFills2Color: 'var(--rt-due)',
  chartPaletteFills3Color: 'var(--rt-struck)',
  chartPaletteFills4Color: 'var(--rt-dim)',
} as never)
