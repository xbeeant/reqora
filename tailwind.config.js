/** @type {import('tailwindcss').Config} */

// Every semantic colour is a CSS variable so the whole UI can flip between the
// light and dark palette from a single `.dark` class on <html>.
const v = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: v("--wb-brand-50"),
          100: v("--wb-brand-100"),
          200: v("--wb-brand-200"),
          300: v("--wb-brand-300"),
          400: v("--wb-brand-400"),
          500: v("--wb-brand-500"),
          600: v("--wb-brand-600"),
          700: v("--wb-brand-700"),
          800: v("--wb-brand-800"),
          900: v("--wb-brand-900"),
        },
        surface: {
          DEFAULT: v("--wb-surface"),
          muted: v("--wb-surface-muted"),
          sunken: v("--wb-surface-sunken"),
          border: v("--wb-surface-border"),
        },
        ink: {
          DEFAULT: v("--wb-ink"),
          soft: v("--wb-ink-soft"),
          faint: v("--wb-ink-faint"),
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI",
          "PingFang SC",
          "Microsoft YaHei",
          "sans-serif",
        ],
        mono: ["SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["11px", "16px"],
      },
      boxShadow: {
        panel: "0 1px 2px rgb(16 24 40 / 0.04), 0 6px 20px rgb(16 24 40 / 0.08)",
      },
    },
  },
  plugins: [],
};
