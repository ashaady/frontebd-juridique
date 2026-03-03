import type { Metadata } from "next";
import Script from "next/script";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkAppearance } from "./_lib/clerk-theme";
import { WorkspaceUserSync } from "./_components/workspace-user-sync";
import "./globals.css";

export const metadata: Metadata = {
  title: "JuridiqueSN",
  description: "Assistant juridique senegalais"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const publishableKey =
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k";

  return (
    <html className="dark" lang="fr" suppressHydrationWarning>
      <head>
        <link href="https://fonts.googleapis.com" rel="preconnect" />
        <link crossOrigin="" href="https://fonts.gstatic.com" rel="preconnect" />
        <link
          href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        style={{ backgroundColor: "#112117", color: "#e5e7eb", opacity: 0 }}
        suppressHydrationWarning
      >
        <ClerkProvider
          appearance={clerkAppearance}
          publishableKey={publishableKey}
          signInForceRedirectUrl="/?new=1"
          signInFallbackRedirectUrl="/?new=1"
          signUpForceRedirectUrl="/?new=1"
          signUpFallbackRedirectUrl="/?new=1"
        >
          <WorkspaceUserSync />
          <Script id="tailwind-config" strategy="beforeInteractive">{`
          window.tailwind = window.tailwind || {};
          window.tailwind.config = {
            darkMode: "class",
            theme: {
              extend: {
                colors: {
                  primary: "#20df6c",
                  "primary-dark": "#18a852",
                  "background-light": "#f6f8f7",
                  "background-dark": "#112117",
                  "surface-dark": "#1E2E24",
                  "surface-card": "#23352b",
                  "panel-dark": "#122118",
                  "card-dark": "#1e2e24",
                  "accent-dark": "#254632",
                  "border-dark": "#2d3f34"
                },
                fontFamily: {
                  display: ["Public Sans", "sans-serif"]
                },
                borderRadius: {
                  DEFAULT: "0.25rem",
                  lg: "0.5rem",
                  xl: "0.75rem",
                  "2xl": "1rem",
                  full: "9999px"
                }
              }
            }
          };
          `}</Script>
          <Script
            src="https://cdn.tailwindcss.com?plugins=forms,container-queries"
            strategy="beforeInteractive"
          />
          <Script id="fouc-fix" strategy="afterInteractive">{`
          (() => {
            const body = document.body;
            if (!body) return;
            body.style.transition = "opacity 150ms ease";
            body.style.opacity = "1";
          })();
          `}</Script>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
