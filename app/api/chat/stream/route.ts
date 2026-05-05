import { NextRequest } from "next/server";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";
import { prisma } from "@/lib/prisma";
import {
  getGeminiClient,
  getGeminiModelId,
  isGeminiConfigured,
} from "@/lib/gemini";
import {
  FunctionCallingMode,
  SchemaType,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/generative-ai";
import type { ChatReply } from "@/lib/chat-tools";
import {
  dispatchChatMessageRegex,
  toolGetDailyReport,
  toolGetPnl,
  toolSearchDocuments,
  toolGetExpenseSummary,
  toolGetJournalSummary,
  toolGetDocumentsList,
} from "@/lib/chat-tools";

type ChatHistoryEntry = {
  role: "user" | "assistant";
  text: string;
};

const MAX_ROUNDS = 5;

const declarations: FunctionDeclaration[] = [
  {
    name: "get_daily_report",
    description: "오늘 영업일 요약 (마감 여부, 미승인 지출 건수 등)",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_pnl",
    description:
      "기간 손익을 조회합니다. 생략 시 이번 달 1일~오늘 영업일까지.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        fromYmd: { type: SchemaType.STRING, description: "시작일 YYYY-MM-DD (선택)" },
        toYmd: { type: SchemaType.STRING, description: "종료일 YYYY-MM-DD (선택)" },
      },
    },
  },
  {
    name: "search_documents",
    description:
      "문서함에서 제목·요약·공급자·OCR 텍스트로 문서를 검색합니다.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "검색어 (필수)" },
        fromYmd: { type: SchemaType.STRING, description: "시작일 YYYY-MM-DD (선택)" },
        toYmd: { type: SchemaType.STRING, description: "종료일 YYYY-MM-DD (선택)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_expense_summary",
    description: "기간별 지출 합계 (공급자별 분류). 생략 시 이번 달.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        fromYmd: { type: SchemaType.STRING, description: "시작일 YYYY-MM-DD (선택)" },
        toYmd: { type: SchemaType.STRING, description: "종료일 YYYY-MM-DD (선택)" },
      },
    },
  },
  {
    name: "get_journal_summary",
    description: "지출 내역 현황 (미승인/승인 건수)",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_documents_list",
    description:
      "기간에 등록된 문서 목록. 상태 필터 가능(processing, needs_review, linked).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        fromYmd: { type: SchemaType.STRING, description: "시작일 YYYY-MM-DD (선택, 기본: 오늘)" },
        toYmd: { type: SchemaType.STRING, description: "종료일 YYYY-MM-DD (선택, 기본: 오늘)" },
        status: { type: SchemaType.STRING, description: "문서 상태 필터 (선택)" },
      },
    },
  },
];

function buildSystemInstruction(timezone: string): string {
  const now = new Date();
  const todayStr = now.toLocaleDateString("sv-SE", { timeZone: timezone });
  const yearStr = now.toLocaleDateString("ko-KR", {
    timeZone: timezone,
    year: "numeric",
  });

  return `당신은 소규모 매장/업체 사장님의 사업 데이터를 기억하는 조회 전용 비서입니다.

■ 현재 날짜: ${todayStr} (${yearStr})

■ 행동 원칙:
- 인사·감사·잡담에는 도구를 호출하지 말고 짧게 한국어로 답하세요.
- 실제 조회가 필요할 때만 도구를 호출하세요.
- 기간 표현을 현재 날짜 기준으로 YYYY-MM-DD로 변환하세요.
- 도구 결과를 바탕으로 한국어로 깔끔하게 요약하세요.
- 링크는 반드시 슬래시(/)로 시작하는 상대 경로를 사용하세요.
- 금액은 숫자에 쉼표를 넣고 "원"을 붙여주세요 (예: 385,000원).
- 여러 문서 데이터를 종합할 때는 표 형태(마크다운 테이블)를 사용하세요.`;
}

async function runTool(
  name: string,
  args: object,
  tenantId: string,
  tenant: { timezone: string },
): Promise<ChatReply> {
  switch (name) {
    case "get_daily_report":
      return toolGetDailyReport(tenantId, tenant);
    case "get_pnl": {
      const a = args as { fromYmd?: string; toYmd?: string };
      return toolGetPnl(tenantId, tenant, a);
    }
    case "search_documents": {
      const a = args as { query?: string; fromYmd?: string; toYmd?: string };
      const q = (a.query ?? "").trim();
      if (!q) return { markdown: "검색어가 필요합니다." };
      return toolSearchDocuments(tenantId, q, {
        fromYmd: a.fromYmd,
        toYmd: a.toYmd,
      });
    }
    case "get_expense_summary": {
      const a = args as { fromYmd?: string; toYmd?: string };
      return toolGetExpenseSummary(tenantId, tenant, a);
    }
    case "get_journal_summary":
      return toolGetJournalSummary(tenantId);
    case "get_documents_list": {
      const a = args as { fromYmd?: string; toYmd?: string; status?: string };
      return toolGetDocumentsList(tenantId, tenant, a);
    }
    default:
      return { markdown: "알 수 없는 도구입니다." };
  }
}

function ndjson(obj: object): string {
  return JSON.stringify(obj) + "\n";
}

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();

  const tenantId = authUser.tenantId;
  if (!tenantId) {
    return new Response(
      ndjson({ type: "error", message: "테넌트가 없습니다." }),
      { status: 400, headers: streamHeaders() },
    );
  }

  let body: { message?: string; history?: ChatHistoryEntry[] };
  try {
    body = await req.json();
  } catch {
    return new Response(
      ndjson({ type: "error", message: "잘못된 요청입니다." }),
      { status: 400, headers: streamHeaders() },
    );
  }

  const message = body.message?.trim();
  if (!message) {
    return new Response(
      ndjson({ type: "error", message: "메시지가 비어있습니다." }),
      { status: 400, headers: streamHeaders() },
    );
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  const tz = tenant?.timezone ?? "Asia/Seoul";
  const history = (body.history ?? []).slice(-20);

  if (!isGeminiConfigured()) {
    const fallback = await dispatchChatMessageRegex(tenantId, message, {
      timezone: tz,
    });
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(
          enc.encode(ndjson({ type: "text_delta", text: fallback.markdown })),
        );
        controller.enqueue(
          enc.encode(ndjson({ type: "done", fullText: fallback.markdown })),
        );
        controller.close();
      },
    });
    return new Response(stream, { headers: streamHeaders() });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: object) => {
        try {
          controller.enqueue(enc.encode(ndjson(obj)));
        } catch {
          // stream already closed
        }
      };

      let fullText = "";

      try {
        const genai = getGeminiClient()!;
        const model = genai.getGenerativeModel({
          model: getGeminiModelId(),
          tools: [{ functionDeclarations: declarations }],
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingMode.AUTO },
          },
          systemInstruction: buildSystemInstruction(tz),
        });

        const geminiHistory: Content[] = history.map((h) => ({
          role: h.role === "user" ? "user" : "model",
          parts: [{ text: h.text }],
        }));

        const chat = model.startChat({ history: geminiHistory });
        let streamResult = await chat.sendMessageStream(message);

        for (let round = 0; round < MAX_ROUNDS; round++) {
          for await (const chunk of streamResult.stream) {
            const text = chunk.text();
            if (text) {
              fullText += text;
              send({ type: "text_delta", text });
            }
          }

          const response = await streamResult.response;
          const calls = response.functionCalls();

          if (!calls?.length) {
            send({ type: "done", fullText });
            controller.close();
            return;
          }

          const responseParts: Part[] = [];
          for (const call of calls) {
            send({
              type: "tool_start",
              tool: call.name,
              args: call.args,
            });
            const out = await runTool(
              call.name,
              call.args as object,
              tenantId,
              { timezone: tz },
            );
            send({
              type: "tool_done",
              tool: call.name,
              summary: out.markdown.slice(0, 80),
            });
            responseParts.push({
              functionResponse: {
                name: call.name,
                response: { markdown: out.markdown },
              },
            });
          }

          streamResult = await chat.sendMessageStream(responseParts);
        }

        // Exceeded max rounds
        const forcePrompt =
          "지금까지 수집한 데이터로 최선의 답변을 생성하세요. 추가 도구 호출 없이 답하세요.";
        const finalStream = await chat.sendMessageStream(forcePrompt);
        for await (const chunk of finalStream.stream) {
          const text = chunk.text();
          if (text) {
            fullText += text;
            send({ type: "text_delta", text });
          }
        }

        send({ type: "done", fullText });
      } catch (err) {
        console.error("[chat/stream] Error:", err);
        send({
          type: "error",
          message: "AI 조회에 실패했습니다. 잠시 후 다시 시도해 주세요.",
        });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, { headers: streamHeaders() });
}

function streamHeaders(): HeadersInit {
  return {
    "Content-Type": "text/plain; charset=utf-8",
    "Transfer-Encoding": "chunked",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
}
