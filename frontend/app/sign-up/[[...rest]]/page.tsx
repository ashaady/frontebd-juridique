import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { clerkAppearance } from "../../_lib/clerk-theme";

export default function SignUpPage() {
  return (
    <main className="min-h-screen bg-[#112117] text-slate-100 px-4 py-10 relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-20 right-0 size-72 rounded-full bg-[#49DE80]/12 blur-3xl" />
        <div className="absolute bottom-0 -left-16 size-80 rounded-full bg-[#49DE80]/10 blur-3xl" />
      </div>
      <div className="relative mx-auto max-w-md">
        <section className="rounded-3xl border border-slate-800 bg-[#122118]/95 p-7 sm:p-8 shadow-2xl backdrop-blur-sm">
          <div className="flex justify-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#49DE80]/35 bg-[#1a2e22] px-4 py-2 text-xs font-semibold text-[#7ef1a9]">
              <span className="material-symbols-outlined text-base text-[#49DE80]">gavel</span>
              JuridiqueSN
            </div>
          </div>
          <h1 className="mt-5 text-center text-2xl font-bold">Creation de compte</h1>
          <p className="mt-2 text-center text-sm text-slate-400">
            Ouvrez votre espace personnel en quelques secondes.
          </p>

          <div className="mt-6 flex justify-center">
            <SignUp
              appearance={clerkAppearance}
              forceRedirectUrl="/?new=1"
              fallbackRedirectUrl="/?new=1"
              path="/sign-up"
              routing="path"
              signInUrl="/sign-in"
            />
          </div>

          <p className="mt-5 text-center text-sm text-slate-400">
            Deja inscrit ?{" "}
            <Link className="font-semibold text-[#49DE80] hover:text-[#7ef1a9]" href="/sign-in">
              Se connecter
            </Link>
          </p>
        </section>
      </div>
    </main>
  );
}
