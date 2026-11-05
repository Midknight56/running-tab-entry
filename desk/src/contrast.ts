export function contrastRatio(hexA: string, hexB: string): number {
  const luminance = (hex: string) => {
    const rgb = hex.replace(/^#/, '').match(/.{2}/g)
    if (!rgb || rgb.length !== 3) throw new Error(`Invalid hex colour: ${hex}`)
    const [r, g, b] = rgb.map((part) => {
      const value = parseInt(part, 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const a = luminance(hexA)
  const b = luminance(hexB)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export const contrastPairs = [
  { theme: 'light', name: 'text on surface', foreground: '#1d2125', background: '#ffffff' },
  { theme: 'light', name: 'dim on surface', foreground: '#66707a', background: '#ffffff' },
  { theme: 'light', name: 'accent on surface', foreground: '#0f766e', background: '#ffffff' },
  { theme: 'light', name: 'text on background', foreground: '#1d2125', background: '#f4f5f6' },
  { theme: 'light', name: 'dim on background', foreground: '#66707a', background: '#f4f5f6' },
  { theme: 'light', name: 'accent on background', foreground: '#0f766e', background: '#f4f5f6' },
  { theme: 'light', name: 'white on accent', foreground: '#ffffff', background: '#0f766e' },
  { theme: 'light', name: 'struck on surface', foreground: '#b42318', background: '#ffffff' },
  { theme: 'light', name: 'due on surface', foreground: '#b45309', background: '#ffffff' },
  { theme: 'light', name: 'ok on surface', foreground: '#15803d', background: '#ffffff' },
  { theme: 'dark', name: 'text on surface', foreground: '#e6e8ea', background: '#1d2125' },
  { theme: 'dark', name: 'dim on surface', foreground: '#9aa3ab', background: '#1d2125' },
  { theme: 'dark', name: 'accent on surface', foreground: '#2dd4bf', background: '#1d2125' },
  { theme: 'dark', name: 'text on background', foreground: '#e6e8ea', background: '#15181b' },
  { theme: 'dark', name: 'dim on background', foreground: '#9aa3ab', background: '#15181b' },
  { theme: 'dark', name: 'accent on background', foreground: '#2dd4bf', background: '#15181b' },
  { theme: 'dark', name: 'dark text on accent', foreground: '#0b1214', background: '#2dd4bf' },
  { theme: 'dark', name: 'struck on surface', foreground: '#f87171', background: '#1d2125' },
  { theme: 'dark', name: 'due on surface', foreground: '#f59e0b', background: '#1d2125' },
  { theme: 'dark', name: 'ok on surface', foreground: '#4ade80', background: '#1d2125' },
] as const
