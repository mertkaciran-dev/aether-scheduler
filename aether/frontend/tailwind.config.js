/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#07080c', 900: '#0b0d13', 850: '#10131b', 800: '#161a24', 700: '#1f2431', 600: '#2a3042', 500: '#3a4259' },
        aether: { 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        'slide-in': { from: { opacity: '0', transform: 'translateY(-6px)' }, to: { opacity: '1', transform: 'none' } },
        'pulse-dot': { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
      },
      animation: { 'slide-in': 'slide-in .25s ease-out', 'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite' },
    },
  },
  plugins: [],
};
