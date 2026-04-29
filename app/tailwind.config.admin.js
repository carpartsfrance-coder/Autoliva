/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/views/admin/**/*.ejs'],
  theme: {
    extend: {
      colors: {
        primary: '#D32F2F',
        'primary-hover': '#B71C1C',
        'background-light': '#F3F4F6',
        'background-dark': '#111827',
        'surface-light': '#FFFFFF',
        'surface-dark': '#1F2937',
        'border-light': '#E5E7EB',
        'border-dark': '#374151',
      },
      fontFamily: {
        display: ['Inter', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        lg: '0.5rem',
        xl: '0.75rem',
        '2xl': '1rem',
        full: '9999px',
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
    require('@tailwindcss/container-queries'),
  ],
};
