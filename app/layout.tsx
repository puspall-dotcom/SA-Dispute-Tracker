import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SA Dispute Tracker",
  description: "SellAbroad — live dispute dashboard sourced from production Postgres.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
