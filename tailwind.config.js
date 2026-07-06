/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Zirtola editor palette — deep slate surfaces, one signal accent.
        ink: {
          950: '#0b0d10', // app background
          900: '#111418', // panel background
          850: '#161a20', // raised panel
          800: '#1c2128', // cards / rails
          700: '#262d36', // borders, track lanes
          600: '#39424e', // muted borders
          500: '#55606e', // disabled text
          400: '#8b96a5', // secondary text
          300: '#aab4c0', // emphasized secondary text (labels)
          200: '#ccd4de', // body text
          50: '#f2f5f8' // headings
        },
        signal: {
          DEFAULT: '#5eead4', // teal signal — playhead, links, active states
          dim: '#2dd4bf',
          deep: '#0f766e'
        },
        cut: '#f87171', // cut regions
        graphic: '#c084fc', // graphics track
        music: '#60a5fa', // music track
        warn: '#fbbf24'
      },
      fontFamily: {
        display: ['"Segoe UI Variable Display"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        body: ['"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Code"', '"Consolas"', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
}
