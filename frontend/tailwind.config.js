/** @type {import('tailwindcss').Config} */
export default {
	content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
	theme: {
		extend: {
			fontFamily: {
				display: ['"Space Grotesk"', "sans-serif"],
				sans: ["Manrope", "sans-serif"],
			},
			colors: {
				ledger: {
					surface: "#ffffff",
					"surface-lowest": "#f7f8fb",
					"surface-low": "#eff2f7",
					"surface-high": "#e2e8f0",
					"surface-highest": "#cbd5e1",
					bright: "#ffffff",
					gold: "#1e6fd6",
					"gold-deep": "#1658b2",
					emerald: "#12946f",
					ink: "#172033",
					mist: "#5b6b80",
					shadow: "#152238",
				},
			},
			boxShadow: {
				glow: "0 10px 24px rgba(30, 111, 214, 0.16)",
				float: "0 18px 40px rgba(21, 34, 56, 0.14)",
			},
			backgroundImage: {
				"gold-dust": "linear-gradient(135deg, #1658b2 0%, #1e6fd6 100%)",
				"vault-radial": "linear-gradient(180deg, #ffffff 0%, #f7f8fb 100%)",
			},
		},
	},
	plugins: [],
};
