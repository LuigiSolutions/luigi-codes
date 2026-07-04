/**
 * Luigi Solutions design tokens — the single source of truth for every color,
 * font, radius, shadow, and motion value Luigi Codes renders.
 *
 * Core values are copied EXACTLY from the flagship design system:
 * luigi-os/packages/ui/src/theme.css. Scale values that luigi-os does not
 * define (elevated surfaces, gold light/dark steps) are derived from those
 * anchors in the same warm hue family and marked "derived" — if luigi-os adds
 * a canonical value later, replace the derived one here.
 *
 * No file in this extension may hard-code a hex. Everything reads LuigiBrand
 * or the CSS variables emitted by cssVariables().
 */

export const LuigiBrand = {
  colors: {
    background: {
      /** --color-canvas — warm near-black canvas. */
      primary: '#0b0a09',
      /** --color-surface — the rare barely-there raised panel. */
      secondary: '#16140f',
      /** derived — one step above surface for cards/bubbles. */
      tertiary: '#1d1a14',
      /** derived — hover/active elevation on tertiary. */
      elevated: '#242019',
    },
    foreground: {
      /** --color-ink — warm off-white, ≈17:1 (AAA). */
      primary: '#f3efe7',
      /** --color-ink-muted — ≈6.6:1 (AA). */
      secondary: '#9c948a',
      /** --color-ink-faint — decorative meta only, never body copy. */
      muted: '#6e675e',
    },
    accent: {
      /** --color-gold — THE accent. Eyebrows, key figures, focus rings, interactive borders. */
      gold: '#c9a86a',
      /** derived — gold lifted for hover states on dark. */
      goldLight: '#dcc18d',
      /** derived — gold deepened for pressed states / large fills. */
      goldDark: '#a8874d',
      /** the signature hairline value: gold at 32% (theme.css --border-hairline). */
      goldGlow: 'rgba(201, 168, 106, 0.32)',
    },
    semantic: {
      /** --color-success. */
      success: '#a3c585',
      /** --color-danger — warm coral-red, inside the palette. */
      error: '#e8796e',
      /** --color-warning. */
      warning: '#d9924a',
      /** --color-info. */
      info: '#8fb5c9',
    },
    border: {
      /** Decorative hairline — gold at 32%, an intentional whisper (frames, rules). */
      subtle: 'rgba(201, 168, 106, 0.32)',
      /** Full gold — the second tier: any line that is the SOLE signal of a control or focus. */
      accent: '#c9a86a',
    },
  },

  typography: {
    fontFamily: {
      /** Code and terminal surfaces — inherits the user's editor font first. */
      primary:
        "var(--vscode-editor-font-family, 'SF Mono'), 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Menlo, monospace",
      /** --font-sans (Inter stack) — UI copy, eyebrows, controls. */
      display:
        "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      /** --font-serif (Newsreader stack) — editorial moments, the wordmark's serif partner. */
      serif: "Newsreader, ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
    },
    /** Uppercase label tracking from theme.css. */
    tracking: {
      eyebrow: '0.15em',
      wordmark: '0.3em',
    },
    fontSizes: {
      xs: '11px',
      sm: '12px',
      base: '13px',
      lg: '15px',
      xl: '18px',
      '2xl': '22px',
      '3xl': '28px',
    },
  },

  spacing: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    '2xl': '32px',
  },

  borderRadius: {
    /** --radius-xs — the barely-there editorial radius (the only canonical one). */
    sm: '2px',
    /** derived — cards and controls; luigi-os defines no larger step. */
    md: '4px',
    /** derived — bubbles and the composer. */
    lg: '8px',
    /** derived — circular elements only. */
    full: '9999px',
  },

  shadows: {
    /** Whisper-level gold aura for focused/hovered gold elements. */
    goldGlow: '0 0 0 1px rgba(201, 168, 106, 0.32), 0 0 18px rgba(201, 168, 106, 0.15)',
    /** Stronger aura for the primary action. */
    goldGlowStrong: '0 0 0 1px rgba(201, 168, 106, 0.55), 0 0 28px rgba(201, 168, 106, 0.28)',
    elevated: '0 8px 28px rgba(0, 0, 0, 0.55)',
    inset: 'inset 0 1px 0 rgba(243, 239, 231, 0.04)',
  },

  animation: {
    duration: {
      /** derived — micro-interactions. */
      fast: '150ms',
      /** --animate-loader-message duration. */
      normal: '400ms',
      /** --animate-reveal duration. */
      slow: '650ms',
    },
    easing: {
      /** The house curve — the system's ONLY curve (theme.css reveal/loader-message). */
      smooth: 'cubic-bezier(0.16, 1, 0.3, 1)',
    },
  },
} as const;

export type LuigiTheme = 'premium-black' | 'premium-dark';

/**
 * Emit the brand as CSS custom properties for webview surfaces.
 * premium-black keeps the pure canvas; premium-dark lifts every surface one
 * step (canvas→surface, surface→tertiary) for lighter-feeling panels.
 */
export function cssVariables(theme: LuigiTheme = 'premium-black'): string {
  const b = LuigiBrand;
  const bg =
    theme === 'premium-dark'
      ? {
          primary: b.colors.background.secondary,
          secondary: b.colors.background.tertiary,
          tertiary: b.colors.background.elevated,
          elevated: b.colors.background.elevated,
        }
      : b.colors.background;
  return `
    --luigi-bg: ${bg.primary};
    --luigi-bg-secondary: ${bg.secondary};
    --luigi-bg-tertiary: ${bg.tertiary};
    --luigi-bg-elevated: ${bg.elevated};
    --luigi-ink: ${b.colors.foreground.primary};
    --luigi-ink-muted: ${b.colors.foreground.secondary};
    --luigi-ink-faint: ${b.colors.foreground.muted};
    --luigi-gold: ${b.colors.accent.gold};
    --luigi-gold-light: ${b.colors.accent.goldLight};
    --luigi-gold-dark: ${b.colors.accent.goldDark};
    --luigi-gold-glow: ${b.colors.accent.goldGlow};
    --luigi-success: ${b.colors.semantic.success};
    --luigi-error: ${b.colors.semantic.error};
    --luigi-warning: ${b.colors.semantic.warning};
    --luigi-info: ${b.colors.semantic.info};
    --luigi-border-subtle: ${b.colors.border.subtle};
    --luigi-border-accent: ${b.colors.border.accent};
    --luigi-font-mono: ${b.typography.fontFamily.primary};
    --luigi-font-display: ${b.typography.fontFamily.display};
    --luigi-font-serif: ${b.typography.fontFamily.serif};
    --luigi-tracking-eyebrow: ${b.typography.tracking.eyebrow};
    --luigi-tracking-wordmark: ${b.typography.tracking.wordmark};
    --luigi-radius-sm: ${b.borderRadius.sm};
    --luigi-radius-md: ${b.borderRadius.md};
    --luigi-radius-lg: ${b.borderRadius.lg};
    --luigi-shadow-glow: ${b.shadows.goldGlow};
    --luigi-shadow-glow-strong: ${b.shadows.goldGlowStrong};
    --luigi-shadow-elevated: ${b.shadows.elevated};
    --luigi-ease: ${b.animation.easing.smooth};
    --luigi-duration-fast: ${b.animation.duration.fast};
    --luigi-duration-normal: ${b.animation.duration.normal};
    --luigi-duration-slow: ${b.animation.duration.slow};
  `;
}
