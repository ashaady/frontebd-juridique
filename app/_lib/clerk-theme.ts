export const clerkAppearance = {
  variables: {
    colorPrimary: "#49DE80",
    colorBackground: "#122118",
    colorText: "#e2e8f0",
    colorInputBackground: "#112117",
    colorInputText: "#e2e8f0",
    borderRadius: "0.75rem",
  },
  elements: {
    card: "bg-[#122118] border border-slate-800 shadow-2xl",
    cardBox: "shadow-2xl",
    headerTitle: "text-slate-100 text-xl font-bold",
    headerSubtitle: "text-slate-400",
    footer: "hidden",
    footerItem: "hidden",
    footerPages: "hidden",
    socialButtonsBlockButton:
      "bg-[#1a2e22] border border-slate-700 text-slate-100 hover:bg-[#254632] transition-colors",
    socialButtonsBlockButtonText: "text-slate-100",
    formButtonPrimary:
      "bg-[#49DE80] hover:bg-[#3fd273] text-[#112117] font-bold transition-colors",
    footerActionLink: "text-[#49DE80] hover:text-[#7ef1a9]",
    formFieldInput:
      "bg-[#112117] border border-slate-700 text-slate-100 placeholder:text-slate-500 focus:border-[#49DE80]",
    formFieldLabel: "text-slate-300",
    formResendCodeLink: "text-[#49DE80]",
    otpCodeFieldInput: "bg-[#112117] border border-slate-700 text-slate-100",
    identityPreviewText: "text-slate-300",
    dividerLine: "bg-slate-700",
    dividerText: "text-slate-500",
    alertText: "text-amber-300",
    modalBackdrop: "bg-black/70",
  },
} as const;

export const clerkUserButtonAppearance = {
  elements: {
    avatarBox: "size-9 ring-2 ring-[#49DE80]/35",
    userButtonPopoverCard: "bg-[#122118] border border-slate-800 text-slate-100",
    userButtonPopoverActionButton:
      "text-slate-200 hover:bg-[#1a2e22] hover:text-[#49DE80] transition-colors",
    userButtonPopoverActionButtonText: "text-inherit",
    userButtonPopoverFooter: "hidden",
  },
} as const;
