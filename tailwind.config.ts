import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx,js,jsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#08090c", 900: "#0c0e13", 800: "#13161d", 700: "#1c2029", 600: "#2a2f3b", 500: "#3a4150" },
        accent: { green: "#46d39a", red: "#ff6e6e", amber: "#ffb648", blue: "#5aa9ff" },
      },
      fontFamily: { mono: ["ui-monospace", "SFMono-Regular", "monospace"] },
    },
  },
  plugins: [],
} satisfies Config;
