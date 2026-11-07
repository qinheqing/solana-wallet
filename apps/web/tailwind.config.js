/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        risk: {
          DEFAULT: "#f59e0b",
        },
      },
    },
  },
  plugins: [],
};
