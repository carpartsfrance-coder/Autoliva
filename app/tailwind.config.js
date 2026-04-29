/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/views/**/*.ejs'],
  theme: {
    extend: {
      colors: {
        primary: '#ec1313',
        'primary-hover': '#B71C1C',
        'dark-grey': '#1a1a1a',
        'footer-red': '#b31d1d',
        'background-light': '#F9FAFB',
        'background-dark': '#111827',
        'surface-light': '#FFFFFF',
        'surface-dark': '#1F2937',
        'accent-dark': '#111827',
        'border-light': '#E5E7EB',
        'border-dark': '#374151',
      },
      fontFamily: {
        display: ['Inter', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
      },
      boxShadow: {
        premium:
          '0 25px 60px -15px rgba(0, 0, 0, 0.05), 0 15px 30px -10px rgba(0, 0, 0, 0.03)',
        'premium-hover':
          '0 35px 70px -15px rgba(0, 0, 0, 0.1), 0 20px 40px -12px rgba(0, 0, 0, 0.06)',
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.5rem',
        xl: '0.75rem',
        '2xl': '1rem',
        '3xl': '2rem',
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
