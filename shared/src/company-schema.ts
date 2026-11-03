import { z } from "zod";
import { COMPANY_ID_RE } from "./ids.ts";

/** Company formats (spec §2). `internal` is the HQ pseudo-company only; it never has a company.yaml. */
export const COMPANY_FORMATS = ["internal", "solo", "partner", "external"] as const;
export type CompanyFormat = (typeof COMPANY_FORMATS)[number];

/** `company.yaml` at the root of each company repo (spec §3). */
export const companyFileSchema = z
  .strictObject({
    id: z.string().regex(COMPANY_ID_RE, "lowercase letters, digits and hyphens; must start with a letter"),
    name: z.string().min(1),
    format: z.enum(["solo", "partner", "external"]),
    telegram_topic_id: z.number().int().positive().nullable().optional(),
    budget_month_usd: z.number().nonnegative(),
    anthropic_key_env: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "name of an environment variable, not the key itself")
      .optional(),
  })
  .superRefine((c, ctx) => {
    if (c.format === "partner" && !c.anthropic_key_env) {
      ctx.addIssue({
        code: "custom",
        path: ["anthropic_key_env"],
        message: "partner companies must declare anthropic_key_env (separate billing)",
      });
    }
  });

export type CompanyFile = z.infer<typeof companyFileSchema>;
