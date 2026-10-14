'use strict';
const { z } = require('zod');
const { STATUSES, PRIORITIES, ROLES } = require('./constants');
const { ValidationError } = require('../errors');

const isRealDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const dateStr = z.string().refine(isRealDate, 'Data non valida (AAAA-MM-GG)');
const emptyToNull = (v) => (v === '' || v === undefined ? null : v);
const id = z.coerce.number().int().positive();

const checklistItem = z.strictObject({
  id: z.string().max(40).optional(),
  text: z.string().trim().min(1, 'Voce vuota').max(200),
  done: z.boolean().default(false),
});

const taskFields = {
  title: z.string().trim().min(1, 'Titolo obbligatorio').max(120),
  description: z.string().max(4000),
  checklist: z.array(checklistItem).max(30),
  priority: z.enum(PRIORITIES),
  status: z.enum(STATUSES),
  category: z.string().trim().max(40),
  assignee_id: z.preprocess(emptyToNull, id.nullable()),
  due_date: z.preprocess(emptyToNull, dateStr.nullable()),
  build_id: z.preprocess(emptyToNull, id.nullable()),
};

const taskPatchSchema = z.strictObject({
  title: taskFields.title.optional(),
  description: taskFields.description.optional(),
  checklist: taskFields.checklist.optional(),
  priority: taskFields.priority.optional(),
  status: taskFields.status.optional(),
  category: taskFields.category.optional(),
  assignee_id: taskFields.assignee_id.optional(),
  due_date: taskFields.due_date.optional(),
  build_id: taskFields.build_id.optional(),
});

const taskCreateSchema = z.strictObject({
  title: taskFields.title,
  description: taskFields.description.default(''),
  checklist: taskFields.checklist.default([]),
  priority: taskFields.priority.default('medium'),
  category: taskFields.category.default(''),
  assignee_id: taskFields.assignee_id.default(null),
  due_date: taskFields.due_date.default(null),
  build_id: taskFields.build_id.default(null),
});

const projectCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'Solo lettere minuscole, numeri e trattini (2-49)'),
  description: z.string().trim().max(300).default(''),
  code_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, '2-8 lettere o numeri').default('TASK'),
});

const projectSettingsSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  categories: z.array(z.string().trim().min(1).max(40)).min(1).max(30),
  discord_guild_id: z.preprocess(emptyToNull, z.string().regex(/^\d{15,25}$/, 'ID server non valido').nullable()),
  discord_forum_id: z.preprocess(emptyToNull, z.string().regex(/^\d{15,25}$/, 'ID canale non valido').nullable()),
  discord_tag_map: z.strictObject({
    status: z.partialRecord(z.enum(STATUSES), z.string().regex(/^\d{15,25}$/)).default({}),
    priority: z.partialRecord(z.enum(PRIORITIES), z.string().regex(/^\d{15,25}$/)).default({}),
  }).default({ status: {}, priority: {} }),
});

const memberSchema = z.strictObject({
  discord_id: z.preprocess(emptyToNull, z.string().regex(/^\d{15,25}$/, 'Discord user ID non valido').nullable()).default(null),
  local_login: z.preprocess(emptyToNull, z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, 'Login: 3-32 caratteri [a-z0-9._-]').nullable()).default(null),
  display_name: z.string().trim().max(60).optional(),
  password: z.preprocess(emptyToNull, z.string().min(12, 'Password di almeno 12 caratteri').max(200).nullable()).default(null),
  role: z.enum(ROLES),
  can_approve: z.boolean().default(false),
});

const memberUpdateSchema = z.strictObject({ role: z.enum(ROLES), can_approve: z.boolean().default(false) });

const buildSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['build', 'milestone']).default('build'),
  due_date: z.preprocess(emptyToNull, dateStr.nullable()).default(null),
  released: z.boolean().default(false),
});

function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const fields = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  throw new ValidationError('Dati non validi', fields);
}

module.exports = {
  parse, taskPatchSchema, taskCreateSchema, projectCreateSchema, projectSettingsSchema,
  memberSchema, memberUpdateSchema, buildSchema, isRealDate,
};
