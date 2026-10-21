import { generateText, Output } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import {
  projectObservationForModel,
  validateBotDecision,
} from "../src/botDecision.js";

const decisionSchema = z.object({
  type: z.enum(["seer_check", "wolf_attack", "speech", "vote"]),
  targetId: z.string().nullable(),
  text: z.string().max(100).nullable(),
});

export function modelConfiguration(environment = process.env) {
  const requestedTimeout = Number(environment.MODEL_TIMEOUT_MS ?? 8000);
  const requiredVariables = [
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_BASE_URL",
    "DASHSCOPE_MODEL",
  ];
  const missing = requiredVariables.filter((name) => !environment[name]?.trim());
  const baseUrl = environment.DASHSCOPE_BASE_URL?.trim().replace(/\/$/, "") ?? "";
  let endpointValid = false;
  try {
    endpointValid = new URL(baseUrl).protocol === "https:" && !baseUrl.includes("{");
  } catch {
    endpointValid = false;
  }
  if (baseUrl && !endpointValid) missing.push("DASHSCOPE_BASE_URL（需为有效 HTTPS 地址）");

  return {
    configured: missing.length === 0,
    provider: "aliyun-bailian",
    model: environment.DASHSCOPE_MODEL?.trim() || null,
    timeoutMs: Number.isFinite(requestedTimeout)
      ? Math.min(30000, Math.max(3000, requestedTimeout))
      : 8000,
    missing,
  };
}

export function buildDecisionPrompt(observation) {
  return [
    "你正在扮演6人教学版狼人杀中的一个角色。",
    "只能依据下面提供的角色可见信息决策，不能假设未提供的身份或私密行动。",
    "必须返回当前 action.type 对应的行动。",
    "选择目标时，targetId 必须来自 action.targets；发言时 targetId 为 null。",
    "发言保持简短，可以推理或伪装，但不得声称看到了未提供的后台信息。",
    "请只输出 JSON，不要添加 Markdown 或额外解释。",
    "角色可见信息：",
    JSON.stringify(observation),
  ].join("\n");
}

export async function requestModelDecision(rawObservation, environment = process.env) {
  const config = modelConfiguration(environment);
  if (!config.configured) {
    const error = new Error(`阿里云百炼配置不完整：${config.missing.join("、")}`);
    error.code = "MODEL_NOT_CONFIGURED";
    throw error;
  }

  const bailian = createOpenAICompatible({
    name: "aliyun-bailian",
    apiKey: environment.DASHSCOPE_API_KEY.trim(),
    baseURL: environment.DASHSCOPE_BASE_URL.trim().replace(/\/$/, ""),
    // 当前配置使用百炼支持 JSON Schema 的千问模型；程序仍会二次校验合法行动。
    supportsStructuredOutputs: true,
  });

  const observation = projectObservationForModel(rawObservation);
  const result = await generateText({
    model: bailian(config.model),
    output: Output.object({ schema: decisionSchema }),
    prompt: buildDecisionPrompt(observation),
    temperature: 0.4,
    maxOutputTokens: 180,
    abortSignal: AbortSignal.timeout(config.timeoutMs),
  });

  return {
    decision: validateBotDecision(observation, result.output),
    provider: config.provider,
    model: config.model,
    usage: result.usage,
  };
}
