"use client";

import { FormEvent, useMemo, useState } from "react";

type ChatRole = "system" | "user" | "assistant";
type FeedbackValue = "correct" | "partial" | "wrong" | null;

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type RagSource = {
  rank?: number;
  score?: number;
  chunk_id?: string;
  citation?: string;
  relative_path?: string;
  source_path?: string;
  page_start?: number;
  page_end?: number;
  article_hint?: string | null;
};

type Turn = {
  id: number;
  question: string;
  answer: string;
  sources: RagSource[];
  ragNote?: string;
  ragError?: string;
  feedback: FeedbackValue;
  isStreaming: boolean;
  error?: string;
};

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8000";

function formatScore(score?: number): string {
  if (typeof score !== "number" || Number.isNaN(score)) {
    return "";
  }
  return score.toFixed(3);
}

function buildMessages(turns: Turn[], nextQuestion: string): ChatMessage[] {
  const historyMessages: ChatMessage[] = [];
  for (const turn of turns) {
    if (!turn.question.trim()) {
      continue;
    }
    historyMessages.push({ role: "user", content: turn.question });
    if (turn.answer.trim()) {
      historyMessages.push({ role: "assistant", content: turn.answer });
    }
  }
  historyMessages.push({ role: "user", content: nextQuestion });
  return historyMessages;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

export default function HomePage() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const backendBaseUrl = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_BACKEND_URL ?? DEFAULT_BACKEND_BASE_URL;
    return raw.replace(/\/+$/, "");
  }, []);

  function updateTurn(turnId: number, updater: (turn: Turn) => Turn) {
    setTurns((prev) =>
      prev.map((turn) => {
        if (turn.id !== turnId) {
          return turn;
        }
        return updater(turn);
      })
    );
  }

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || isSending) {
      return;
    }

    setIsSending(true);
    setRequestError(null);

    const payload = {
      messages: buildMessages(turns, trimmed),
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 1024,
      thinking: false
    };

    const turnId = Date.now();
    setTurns((prev) => [
      ...prev,
      {
        id: turnId,
        question: trimmed,
        answer: "",
        sources: [],
        feedback: null,
        isStreaming: true
      }
    ]);
    setQuestion("");

    try {
      const response = await fetch(`${backendBaseUrl}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(`HTTP ${response.status} - ${bodyText}`);
      }

      if (!response.body) {
        throw new Error("Le stream SSE est vide.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let dataLines: string[] = [];
      let doneSeen = false;

      const flushEvent = () => {
        if (dataLines.length === 0) {
          currentEvent = "";
          return;
        }

        const payloadObject = parseJsonObject(dataLines.join("\n"));
        const eventName = currentEvent.toLowerCase();

        if (eventName === "meta") {
          const ragSources = Array.isArray(payloadObject.rag_sources)
            ? (payloadObject.rag_sources as RagSource[])
            : [];
          const ragError =
            typeof payloadObject.rag_error === "string" ? payloadObject.rag_error : undefined;
          const ragNote =
            typeof payloadObject.rag_note === "string" ? payloadObject.rag_note : undefined;
          updateTurn(turnId, (turn) => ({
            ...turn,
            sources: ragSources,
            ragError,
            ragNote
          }));
        } else if (eventName === "token") {
          const text = typeof payloadObject.text === "string" ? payloadObject.text : "";
          if (text) {
            updateTurn(turnId, (turn) => ({
              ...turn,
              answer: `${turn.answer}${text}`
            }));
          }
        } else if (eventName === "error") {
          const detail =
            typeof payloadObject.detail === "string" ? payloadObject.detail : "Erreur stream";
          updateTurn(turnId, (turn) => ({
            ...turn,
            error: detail,
            isStreaming: false
          }));
          doneSeen = true;
        } else if (eventName === "done") {
          doneSeen = true;
          updateTurn(turnId, (turn) => ({
            ...turn,
            isStreaming: false,
            answer: turn.answer.trim() ? turn.answer : "Aucune reponse retournee."
          }));
        }

        currentEvent = "";
        dataLines = [];
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line === "") {
            flushEvent();
            if (doneSeen) {
              break;
            }
            continue;
          }
          if (line.startsWith(":")) {
            continue;
          }
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }

        if (doneSeen) {
          break;
        }
      }

      buffer += decoder.decode();
      if (buffer.length > 0 && !doneSeen) {
        const tailLines = buffer.split(/\r?\n/);
        for (const line of tailLines) {
          if (line === "") {
            flushEvent();
            continue;
          }
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }
        flushEvent();
      }

      if (!doneSeen) {
        updateTurn(turnId, (turn) => ({
          ...turn,
          isStreaming: false,
          answer: turn.answer.trim() ? turn.answer : "Aucune reponse retournee."
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur inconnue";
      setRequestError(message);
      updateTurn(turnId, (turn) => ({
        ...turn,
        error: message,
        isStreaming: false
      }));
    } finally {
      setIsSending(false);
    }
  }

  function setFeedback(turnId: number, feedback: FeedbackValue) {
    setTurns((prev) =>
      prev.map((turn) => {
        if (turn.id !== turnId) {
          return turn;
        }
        return { ...turn, feedback };
      })
    );
  }

  function clearConversation() {
    if (isSending) {
      return;
    }
    setTurns([]);
    setQuestion("");
    setRequestError(null);
  }

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Assistant juridique RAG</p>
        <h1>Interface Next.js</h1>
        <p className="subtitle">
          Pose une question, recois la reponse en streaming SSE, consulte les sources RAG et marque le feedback.
        </p>
        <p className="backend">
          Backend: <code>{backendBaseUrl}</code>
        </p>
      </section>

      <section className="composer">
        <form onSubmit={submitQuestion}>
          <label htmlFor="question-input">Question</label>
          <textarea
            id="question-input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ex: Quelle est la duree legale du travail par semaine au Senegal ?"
            rows={4}
            disabled={isSending}
          />
          <div className="composer-actions">
            <button type="submit" disabled={isSending || !question.trim()}>
              {isSending ? "Envoi..." : "Envoyer"}
            </button>
            <button type="button" className="secondary" onClick={clearConversation} disabled={isSending}>
              Effacer historique
            </button>
          </div>
        </form>
        {requestError ? <p className="error">Erreur reseau/API: {requestError}</p> : null}
      </section>

      <section className="history">
        {turns.length === 0 ? (
          <div className="empty">
            <p>Aucun echange pour le moment.</p>
          </div>
        ) : null}

        {turns.map((turn, index) => (
          <article key={turn.id} className="turn">
            <header>
              <h2>Echange {index + 1}</h2>
            </header>
            <div className="question">
              <h3>Question</h3>
              <p>{turn.question}</p>
            </div>

            <div className="answer">
              <h3>Reponse</h3>
              {turn.error ? <p className="error">{turn.error}</p> : <p>{turn.answer || "(vide)"}</p>}
              {turn.isStreaming ? <p className="meta">Generation en cours...</p> : null}
            </div>

            <div className="feedback">
              <p>Feedback:</p>
              <button
                type="button"
                className={turn.feedback === "correct" ? "active" : ""}
                onClick={() => setFeedback(turn.id, "correct")}
                disabled={turn.isStreaming}
              >
                Correct
              </button>
              <button
                type="button"
                className={turn.feedback === "partial" ? "active" : ""}
                onClick={() => setFeedback(turn.id, "partial")}
                disabled={turn.isStreaming}
              >
                Incomplet
              </button>
              <button
                type="button"
                className={turn.feedback === "wrong" ? "active" : ""}
                onClick={() => setFeedback(turn.id, "wrong")}
                disabled={turn.isStreaming}
              >
                Faux
              </button>
            </div>

            <div className="sources">
              <h3>Sources RAG ({turn.sources.length})</h3>
              {turn.sources.length === 0 ? <p>Aucune source retournee.</p> : null}
              {turn.sources.length > 0 ? (
                <ul>
                  {turn.sources.map((source, sourceIndex) => (
                    <li key={`${turn.id}-${sourceIndex}`}>
                      <p>
                        <strong>#{source.rank ?? sourceIndex + 1}</strong>{" "}
                        {source.citation ?? source.relative_path ?? "source inconnue"}
                      </p>
                      <p className="meta">
                        score: {formatScore(source.score) || "n/a"}
                        {source.article_hint ? ` | article: ${source.article_hint}` : ""}
                        {typeof source.page_start === "number"
                          ? ` | page: ${source.page_start}${
                              typeof source.page_end === "number" && source.page_end !== source.page_start
                                ? `-${source.page_end}`
                                : ""
                            }`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {turn.ragNote ? (
              <p className="rag-note">
                RAG note: <code>{turn.ragNote}</code>
              </p>
            ) : null}
            {turn.ragError ? (
              <p className="rag-error">
                RAG erreur: <code>{turn.ragError}</code>
              </p>
            ) : null}
          </article>
        ))}
      </section>
    </main>
  );
}
