/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx,html}",
    "./frontend/index.html",
    "./frontend/src/**/*.{js,ts,jsx,tsx,html}",
  ],
  theme: {
    extend: {
      colors: {
        darkBg: "#0a0d14",
        cardBg: "rgba(18, 24, 38, 0.75)",
        accentGreen: "#10b981",
        accentPurple: "#8b5cf6",
        accentPink: "#ec4899",
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
