import type { Config } from "tailwindcss";

/** RASSCO teal scale — remaps emerald/cyan utilities used across the portal */
const rasscoTeal = {
  50: "#eefbfb",
  100: "#d5f5f4",
  200: "#aeeae8",
  300: "#79d9d6",
  400: "#3fc4c1",
  500: "#18B2B0",
  600: "#149D9B",
  700: "#117f7e",
  800: "#0f6564",
  900: "#0e5352",
  950: "#053534",
};

export default {
  darkMode: ["class"],
  content: [
    "./apps/portal/index.html",
    "./apps/portal/src/**/*.{js,jsx,ts,tsx}",
    "./apps/fani-web/index.html",
    "./apps/fani-web/src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "16px",
        "2xl": "18px",
      },
      boxShadow: {
        card: "var(--shadow-card)",
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        chart: {
          "1": "var(--chart-1)",
          "2": "var(--chart-2)",
          "3": "var(--chart-3)",
          "4": "var(--chart-4)",
          "5": "var(--chart-5)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar)",
          foreground: "var(--sidebar-foreground)",
          primary: "var(--sidebar-primary)",
          "primary-foreground": "var(--sidebar-primary-foreground)",
          accent: "var(--sidebar-accent)",
          "accent-foreground": "var(--sidebar-accent-foreground)",
          border: "var(--sidebar-border)",
          ring: "var(--sidebar-ring)",
        },
        success: "var(--success)",
        warning: "var(--warning)",
        rassco: {
          DEFAULT: "#18B2B0",
          hover: "#149D9B",
          gray: "#6B7280",
          bg: "#F8FAFB",
          card: "#FFFFFF",
          border: "#E6E8EC",
          text: "#2D3135",
          muted: "#6B7280",
          danger: "#E05252",
          warning: "#F4B740",
        },
        // Remap popular hard-coded palette names → RASSCO primary
        emerald: rasscoTeal,
        cyan: rasscoTeal,
        teal: rasscoTeal,
      },
      fontFamily: {
        sans: ["Cairo", "Noto Kufi Arabic", "Montserrat", "var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        cairo: ["Cairo", "Noto Kufi Arabic", "sans-serif"],
        serif: ["Cairo", "Montserrat", "Noto Kufi Arabic", "var(--font-serif)", "Georgia", "serif"],
        mono: ["var(--font-mono)"],
        arabic: ["Cairo", "Noto Kufi Arabic", "ui-sans-serif", "system-ui", "sans-serif"],
        montserrat: ["Montserrat", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
        "slide-in-left": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "slide-in-left": "slide-in-left 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
} satisfies Config;
