import { ChatWorkspace } from "../_components/chat-workspace";

type ChatPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const rawQuestion = resolvedSearchParams.q;
  const rawAct = resolvedSearchParams.act;
  const initialQuestion =
    typeof rawQuestion === "string" ? rawQuestion : Array.isArray(rawQuestion) ? rawQuestion[0] ?? "" : "";
  const autoOpenActGenerator =
    typeof rawAct === "string" ? ["1", "true", "yes"].includes(rawAct.toLowerCase()) : false;
  return <ChatWorkspace initialQuestion={initialQuestion} autoOpenActGenerator={autoOpenActGenerator} />;
}
