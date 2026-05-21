import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Indian Stock Analyzer",
  description: "NSE/BSE watchlist — fundamentals, technicals, concalls, macro",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 min-h-screen font-mono">
        <nav className="bg-white border-b border-gray-200 px-6 py-3 flex gap-6 text-sm">
          <a href="/" className="text-blue-600 hover:text-blue-800 font-semibold">Watchlist</a>
          <a href="/macro" className="text-gray-500 hover:text-gray-700">Macro</a>
          <a href="/runs" className="text-gray-500 hover:text-gray-700">Runs</a>
        </nav>
        <main className="px-6 pt-3 pb-6">{children}</main>
      </body>
    </html>
  );
}
