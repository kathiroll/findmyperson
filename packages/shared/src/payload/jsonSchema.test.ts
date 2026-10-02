import { expect, test } from 'vitest';
import { z } from 'zod';
import { contractJson } from '../testing/contractFile';
import { rawBundle, rawIndex, rawQuery } from '../testing/fixtures';
import { ShardBundleSchema, ShardIndexSchema } from './bundle';
import { BroadcastQuerySchema } from './query';

/**
 * The broadcast formats as JSON Schema, committed under contracts/ so that someone can write an
 * independent reader or publisher without reading TypeScript (plan 9.1). The zod schemas are
 * the source; these files are generated from them and checked here.
 *
 * JSON Schema cannot express the cross-field rules (window order, lifetime cap, H3 validity),
 * so each file's description says so. The zod schema remains the full definition.
 */
const NOTE =
  'GENERATED from packages/shared/src/payload by jsonSchema.test.ts; do not edit by hand. ' +
  'Members not listed here are allowed and must be ignored by a reader. ' +
  'Cross-field rules and H3 cell validity are not expressible here: see the zod schema.';

/**
 * `io: 'input'` describes what a reader accepts. The default describes what parsing returns,
 * which forbids extra members, and publishing that would contradict the forward-compatibility
 * rule that unknown members are ignored (plan 6.5).
 */
const toJsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' });

const schemas = [
  ['broadcast-query', BroadcastQuerySchema, rawQuery],
  ['shard-bundle', ShardBundleSchema, rawBundle],
  ['shard-index', ShardIndexSchema, rawIndex],
] as const;

test.each(schemas)('contracts/%s.schema.json is the committed copy', async (name, schema) => {
  const path = `../../contracts/${name}.schema.json`;
  const jsonSchema = { ...toJsonSchema(schema), $comment: NOTE };
  const text = await contractJson(jsonSchema, new URL(path, import.meta.url));
  await expect(text).toMatchFileSnapshot(path);
});

test.each(schemas)(
  'the %s schema lists the members a reader must find',
  (_name, schema, sample) => {
    const jsonSchema = toJsonSchema(schema) as { required?: string[]; properties?: object };
    const required = new Set(jsonSchema.required ?? []);
    expect(required.has('v')).toBe(true);
    expect(required.has('key_id')).toBe(true);
    expect(required.has('sig')).toBe(true);
    // Every member of the signed sample is described, so the schema and the fixture agree.
    const described = new Set(Object.keys(jsonSchema.properties ?? {}));
    expect(Object.keys(sample()).filter((member) => !described.has(member))).toEqual([]);
  },
);

test.each(schemas)('the %s schema does not forbid members it does not know', (_name, schema) => {
  expect(JSON.stringify(toJsonSchema(schema))).not.toContain('"additionalProperties":false');
});
