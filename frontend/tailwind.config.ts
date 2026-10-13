import type { Config } from "tailwindcss";

// Colours are CSS variables (app/globals.css) so the palette lives in one place.
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: v("paper"),
        sheet: v("sheet"),
        ink: v("ink"),
        graphite: v("graphite"),
        mute: v("mute"),
        rule: v("rule"),
        signal: v("signal"),
        moss: v("moss"),
        ochre: v("ochre"),
        night: v("night"),
      },
      fontFamily: {
        serif: ["var(--font-serif)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      letterSpacing: { label: "0.14em" },
    },
  },
  plugins: [],
};

export default config;
