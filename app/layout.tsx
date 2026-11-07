import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Enrich · Email Enrichment",
  description: "Find contact emails from your website list and export an enriched CSV.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
