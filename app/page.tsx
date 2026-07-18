import { ChatWorkspace } from "./_components/chat-workspace";

type HomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const rawQuestion = resolvedSearchParams.q;
  const rawAct = resolvedSearchParams.act;
  const rawTemplate = resolvedSearchParams.template;
  const rawNewSession = resolvedSearchParams.new;
  const rawSession = resolvedSearchParams.session;
  const initialQuestion =
    typeof rawQuestion === "string" ? rawQuestion : Array.isArray(rawQuestion) ? rawQuestion[0] ?? "" : "";
  const autoOpenActGenerator =
    typeof rawAct === "string" ? ["1", "true", "yes"].includes(rawAct.toLowerCase()) : false;
  const initialActTemplateId =
    typeof rawTemplate === "string"
      ? rawTemplate
      : Array.isArray(rawTemplate)
        ? rawTemplate[0] ?? ""
        : "";
  const initialStartNewSession =
    typeof rawNewSession === "string"
      ? ["1", "true", "yes"].includes(rawNewSession.toLowerCase())
      : false;
  const initialSessionId =
    typeof rawSession === "string" ? rawSession : Array.isArray(rawSession) ? rawSession[0] ?? "" : "";

  return (
    <ChatWorkspace
      autoOpenActGenerator={autoOpenActGenerator}
      initialQuestion={initialQuestion}
      initialActTemplateId={initialActTemplateId}
      initialStartNewSession={initialStartNewSession}
      initialSessionId={initialSessionId}
    />
  );
}
