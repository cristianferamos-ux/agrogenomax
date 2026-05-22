/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        void: '#020508',
        graphite: '#081017',
        neon: '#9cff1a',
        aqua: '#00d8ff',
        steel: '#a7b3c2',
      },
      boxShadow: {
        neon: '0 0 36px rgba(156, 255, 26, 0.28)',
        aqua: '0 0 36px rgba(0, 216, 255, 0.25)',
      },
    },
  },
  plugins: [],
};
