/**
 * Zod schemas for every API boundary. Parsed with `.parse` in the handler;
 * throws become 400 via the Fastify error serializer.
 */

import { z } from 'zod';

export const DraftIdParamSchema = z.object({
  id: z.uuid(),
});
export type DraftIdParam = z.infer<typeof DraftIdParamSchema>;

export const EditsBodySchema = z.object({
  editedText: z.string().min(1).max(100_000),
});
export type EditsBody = z.infer<typeof EditsBodySchema>;

// ECS task ARN format:
//   arn:aws:ecs:<region>:<account>:task/<cluster-name>/<32-hex-chars>
// Lenient pattern — a strict regex on AWS ARN shapes tends to break when AWS
// extends the format; we just check the prefix + the colon/slash structure.
export const EcsTaskArnParamSchema = z.object({
  taskArn: z.string().regex(/^arn:aws:ecs:[a-z0-9-]+:\d{12}:task\/[\w.-]+\/[a-f0-9]{32}$/i, {
    message: 'taskArn must be a valid ECS task ARN',
  }),
});
export type EcsTaskArnParam = z.infer<typeof EcsTaskArnParamSchema>;

export class ValidationError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];
  constructor(issues: readonly z.core.$ZodIssue[]) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new ValidationError(result.error.issues);
  return result.data;
}
