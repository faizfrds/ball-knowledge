export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_INPUT_USD_PER_MTOK = 0.02;

export interface EmbeddingBatchResult {
  vectors: number[][];
  inputTokens: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(inputs: readonly string[]): Promise<EmbeddingBatchResult>;
}

interface OpenAiEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/** Mockable native-fetch client. It returns vectors only to retrieval callers. */
export class OpenAIEmbeddingsClient implements EmbeddingProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(args: { apiKey: string; model?: string; fetchImpl?: typeof fetch }) {
    if (!args.apiKey.trim()) throw new Error("OpenAI embeddings API key is required");
    this.apiKey = args.apiKey.trim();
    this.model = args.model ?? DEFAULT_EMBEDDING_MODEL;
    this.fetchImpl = args.fetchImpl ?? fetch;
  }

  async embed(inputs: readonly string[]): Promise<EmbeddingBatchResult> {
    if (inputs.length === 0) return { vectors: [], inputTokens: 0 };
    if (inputs.length > 500) throw new Error("Embedding batch cannot exceed 500 inputs");
    if (inputs.some((input) => typeof input !== "string" || input.length === 0)) {
      throw new Error("Embedding inputs must be non-empty strings");
    }
    const response = await this.fetchImpl("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: inputs, encoding_format: "float" }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      // Do not surface response bodies, which can echo request content.
      throw new Error(`OpenAI embeddings failed: HTTP ${response.status} model=${this.model}`);
    }
    const payload = (await response.json()) as OpenAiEmbeddingResponse;
    if (!Array.isArray(payload.data) || payload.data.length !== inputs.length) {
      throw new Error("OpenAI embeddings returned an unexpected vector count");
    }
    const vectors = [...payload.data]
      .sort((a, b) => a.index - b.index)
      .map((row) => row.embedding);
    const dimensions = vectors[0]?.length ?? 0;
    if (dimensions < 1 || vectors.some((vector) =>
      vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))) {
      throw new Error("OpenAI embeddings returned invalid vectors");
    }
    return { vectors, inputTokens: payload.usage?.prompt_tokens ?? payload.usage?.total_tokens ?? 0 };
  }
}
