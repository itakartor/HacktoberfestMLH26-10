import { z } from 'zod';

// Contract for what Gemma may return. Anything outside this goes to quarantine.

export const CERTAINTY = ['certo', 'condizionato', 'ipotetico', 'ambiguo', 'negato'];
export const ITEM_KINDS = ['fact', 'commitment', 'decision', 'need', 'risk', 'open_question'];

const sourceIds = z.array(z.string().min(1)).min(1).max(6);

export const ExtractedItemSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  content: z.string().min(3).max(400),
  epistemic: z.enum(['dichiarazione', 'inferenza', 'ipotesi']),
  certainty: z.enum(CERTAINTY),
  owner: z.string().max(80).nullable(),
  due: z.string().max(80).nullable(),
  conditions: z.string().max(300).nullable(),
  source_segment_ids: sourceIds,
  quote: z.string().min(2).max(500),
});

export const ExtractedFieldSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1).max(200),
  certainty: z.enum(CERTAINTY),
  source_segment_ids: sourceIds,
  quote: z.string().min(2).max(500),
});

export const ExtractedQuestionSchema = z.object({
  text: z.string().min(5).max(250),
  reason: z.string().max(250),
  field_key: z.string().nullable(),
});

export const ExtractionOutputSchema = z.object({
  items: z.array(ExtractedItemSchema).max(12),
  fields: z.array(ExtractedFieldSchema).max(12),
  questions: z.array(ExtractedQuestionSchema).max(3),
});

export const AnswerOutputSchema = z.object({
  answer: z.string().min(1).max(1500),
  sufficient_evidence: z.boolean(),
  citations: z.array(z.string()).max(8),
  confidence: z.enum(['alta', 'media', 'bassa']),
  confidence_reason: z.string().max(300),
  missing_information: z.array(z.string()).max(5),
});

export const ReportOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  topics: z.array(z.string()).max(8),
  open_points: z.array(z.string()).max(10),
  needs_human_confirmation: z.array(z.string()).max(10),
});

export const jsonSchemaOf = (schema) => z.toJSONSchema(schema, { target: 'draft-7' });
