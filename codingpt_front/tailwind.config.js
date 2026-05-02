/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'body': '#131F24',
        'main': '#37464F',
      },
      backgroundColor: {
        'body': '#131F24',
        'main': '#37464F',
      },
      borderColor: {
        'main': '#37464F',
      },
      borderWidth: {
        '1': '1px', 
      },
      marginTop:{
        'header': '88px',
      },
      height:{
        'header': '88px',
      }
    },
  },
  plugins: [],
}