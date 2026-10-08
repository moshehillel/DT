import { z } from "zod";

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(8080),
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z.string().default("info"),
    AUTH_MODE: z.enum(["firebase", "dev"]).default("firebase"),
    FIREBASE_PROJECT_ID: z.string().default(""),
    DEV_AUTH_SECRET: z.string().default(""),
    OPERATOR_TOKEN_SECRET: z.string().min(32),
    FIELD_ENCRYPTION_KEYS: z.string().min(1),
    FIELD_ENCRYPTION_CURRENT_KEY: z.string().min(1),
    PAYMENT_GATEWAY: z.enum(["fake", "cardknox"]).default("fake"),
    CORS_ORIGINS: z.string().default(""),
    PUBLIC_BASE_URL: z.string().default("http://localhost:8080"),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && value.AUTH_MODE === "dev") {
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=dev is not allowed in production" });
    }
    if (value.NODE_ENV === "production" && value.PAYMENT_GATEWAY === "fake") {
      ctx.addIssue({ code: "custom", message: "PAYMENT_GATEWAY=fake is not allowed in production" });
    }
    if (value.AUTH_MODE === "firebase" && !value.FIREBASE_PROJECT_ID) {
      ctx.addIssue({ code: "custom", message: "FIREBASE_PROJECT_ID is required for AUTH_MODE=firebase" });
    }
    if (value.AUTH_MODE === "dev" && value.DEV_AUTH_SECRET.length < 32) {
      ctx.addIssue({ code: "custom", message: "DEV_AUTH_SECRET must be at least 32 characters" });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
  return parsed.data;
}
