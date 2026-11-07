import { Router, type Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { cellToString } from "../lib/csv.js";
import {
  OWNER_ONLY_VISIBLE_TAGS,
  canAssignTag,
  canSeeParty,
  normalizePhone,
  parsePartyTag,
  type PartyTag,
} from "../lib/parties.js";

// Party/contact master — the single list of buyers, vendors, staff,
// transporters, etc. shared by orders and the call desk (see
// docs/call-desk/COMBINED_PLAN.md, gap G1). Family contacts (VIP_FAMILY) are
// invisible to everyone but the Owner, and VIP-class tags can only be
// assigned by the Owner (lib/parties.ts).
export const partiesRouter = Router();

partiesRouter.use(requireAuth);

const partyInclude = { phones: { orderBy: { createdAt: "asc" } } } satisfies Prisma.PartyInclude;

const tagSchema = z.string().transform((v, ctx) => {
  const tag = parsePartyTag(v);
  if (!tag) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown tag "${v}"` });
    return z.NEVER;
  }
  return tag;
});

const phoneInput = z.object({ phone: z.string().min(1), label: z.string().optional() });

const partyFields = {
  name: z.string().trim().min(1),
  firm: z.string().trim().optional(),
  city: z.string().trim().optional(),
  tag: tagSchema.optional(),
  ownerStaff: z.string().trim().optional(),
  backupStaff: z.string().trim().optional(),
  language: z.string().trim().optional(),
  voiceOnly: z.boolean().optional(),
  recordCalls: z.boolean().optional(),
  notes: z.string().optional(),
};

const createSchema = z.object({ ...partyFields, phones: z.array(phoneInput).min(1) });
const updateSchema = z.object({ ...partyFields, name: partyFields.name.optional(), phones: z.array(phoneInput).min(1).optional() });

class PartyInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// Normalizes and de-duplicates the phones, and rejects any already owned by
// a different party (a phone can only belong to one party — that is what
// makes caller-ID lookup unambiguous).
async function preparePhones(phones: { phone: string; label?: string }[], partyId: string | null) {
  const prepared = new Map<string, string | undefined>();
  for (const p of phones) {
    const normalized = normalizePhone(p.phone);
    if (!normalized) throw new PartyInputError(`"${p.phone}" is not a valid phone number`);
    if (!prepared.has(normalized)) prepared.set(normalized, p.label);
  }
  const taken = await prisma.partyPhone.findMany({
    where: { phone: { in: [...prepared.keys()] }, ...(partyId ? { partyId: { not: partyId } } : {}) },
  });
  if (taken.length > 0) {
    throw new PartyInputError(`${taken.map((t) => t.phone).join(", ")} already belongs to another party`, 409);
  }
  return [...prepared].map(([phone, label]) => ({ phone, label }));
}

function sendError(res: Response, err: unknown) {
  if (err instanceof PartyInputError) return res.status(err.status).json({ error: err.message });
  throw err;
}

partiesRouter.get("/", requirePermission("parties.view"), async (req: AuthedRequest, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const tag = typeof req.query.tag === "string" ? parsePartyTag(req.query.tag) : null;
  const digits = q.replace(/\D/g, "");

  let tagFilter: Prisma.PartyWhereInput["tag"];
  if (tag) {
    if (!canSeeParty(req.user!.role, tag)) return res.json([]);
    tagFilter = tag;
  } else if (req.user!.role !== "OWNER") {
    tagFilter = { notIn: [...OWNER_ONLY_VISIBLE_TAGS] };
  }

  const where: Prisma.PartyWhereInput = {
    ...(tagFilter ? { tag: tagFilter } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { firm: { contains: q, mode: "insensitive" } },
            { city: { contains: q, mode: "insensitive" } },
            ...(digits.length >= 4 ? [{ phones: { some: { phone: { contains: digits } } } }] : []),
          ],
        }
      : {}),
  };
  const parties = await prisma.party.findMany({ where, include: partyInclude, orderBy: { name: "asc" }, take: 200 });
  res.json(parties);
});

partiesRouter.get("/:id", requirePermission("parties.view"), async (req: AuthedRequest, res) => {
  const party = await prisma.party.findUnique({ where: { id: req.params.id }, include: partyInclude });
  if (!party || !canSeeParty(req.user!.role, party.tag)) return res.status(404).json({ error: "Party not found" });
  res.json(party);
});

partiesRouter.post("/", requirePermission("parties.edit"), async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  const { phones, ...fields } = parsed.data;
  const tag: PartyTag = fields.tag ?? "UNKNOWN";
  if (!canAssignTag(req.user!.role, tag)) return res.status(403).json({ error: `Only the Owner can assign the ${tag} tag` });

  try {
    const preparedPhones = await preparePhones(phones, null);
    const party = await prisma.party.create({
      data: { ...fields, tag, phones: { create: preparedPhones } },
      include: partyInclude,
    });
    await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "Party", entityId: party.id, after: party });
    res.status(201).json(party);
  } catch (err) {
    sendError(res, err);
  }
});

partiesRouter.patch("/:id", requirePermission("parties.edit"), async (req: AuthedRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  const before = await prisma.party.findUnique({ where: { id: req.params.id }, include: partyInclude });
  if (!before || !canSeeParty(req.user!.role, before.tag)) return res.status(404).json({ error: "Party not found" });

  const { phones, ...fields } = parsed.data;
  if (fields.tag && fields.tag !== before.tag) {
    // Both directions are guarded: a non-Owner can neither promote a party
    // into a VIP tag nor demote one out of it.
    if (!canAssignTag(req.user!.role, fields.tag) || !canAssignTag(req.user!.role, before.tag)) {
      return res.status(403).json({ error: "Only the Owner can change a VIP tag" });
    }
  }

  try {
    const preparedPhones = phones ? await preparePhones(phones, before.id) : null;
    const party = await prisma.$transaction(async (tx) => {
      if (preparedPhones) {
        await tx.partyPhone.deleteMany({ where: { partyId: before.id } });
        await tx.partyPhone.createMany({ data: preparedPhones.map((p) => ({ ...p, partyId: before.id })) });
      }
      return tx.party.update({ where: { id: before.id }, data: fields, include: partyInclude });
    });
    await recordAudit({ userId: req.user!.id, action: "UPDATE", entityType: "Party", entityId: party.id, before, after: party });
    res.json(party);
  } catch (err) {
    sendError(res, err);
  }
});

// Bulk import of the call desk's contact-tagging sheet (one row per party).
// Rows are matched to existing parties by any of their phone numbers, so
// re-importing an updated sheet updates rather than duplicates. Each row
// succeeds or fails on its own; the response says which and why.
const importSchema = z.object({ rows: z.array(z.record(z.unknown())).min(1).max(2000) });

const PHONE_COLUMNS = ["phone", "phone2", "phone3"];

partiesRouter.post("/import", requirePermission("parties.edit"), async (req: AuthedRequest, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const results: { row: number; status: "created" | "updated" | "error"; partyId?: string; error?: string }[] = [];

  for (const [index, raw] of parsed.data.rows.entries()) {
    const row = index + 1;
    // Header names are matched case-insensitively ("Name", "OWNER STAFF", "owner_staff").
    const cells = new Map(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase().replace(/[\s-]+/g, "_"), v]));
    const cell = (key: string) => cellToString(cells.get(key));
    const yesNo = (key: string) => {
      const v = cell(key)?.toLowerCase();
      return v === undefined ? undefined : ["y", "yes", "true", "1", "haan"].includes(v);
    };

    const name = cell("name");
    if (!name) {
      results.push({ row, status: "error", error: "Name is required" });
      continue;
    }
    const rawTag = cell("tag");
    const tag = rawTag ? parsePartyTag(rawTag) : null;
    if (rawTag && !tag) {
      results.push({ row, status: "error", error: `Unknown tag "${rawTag}"` });
      continue;
    }
    const phones = PHONE_COLUMNS.map(cell).filter((p): p is string => !!p);
    if (phones.length === 0) {
      results.push({ row, status: "error", error: "At least one phone number is required" });
      continue;
    }
    const normalized = phones.map(normalizePhone);
    const badIndex = normalized.findIndex((p) => !p);
    if (badIndex >= 0) {
      results.push({ row, status: "error", error: `"${phones[badIndex]}" is not a valid phone number` });
      continue;
    }

    const fields = {
      name,
      firm: cell("firm"),
      city: cell("city"),
      ownerStaff: cell("owner_staff"),
      backupStaff: cell("backup_staff"),
      language: cell("language"),
      voiceOnly: yesNo("voice_only"),
      recordCalls: yesNo("record_calls"),
      notes: cell("notes"),
    };

    try {
      const owners = await prisma.partyPhone.findMany({ where: { phone: { in: normalized as string[] } }, include: { party: true } });
      const ownerIds = [...new Set(owners.map((o) => o.partyId))];
      if (ownerIds.length > 1) throw new PartyInputError("These phone numbers belong to different existing parties");
      const existing = owners[0]?.party ?? null;

      if (existing) {
        if (!canSeeParty(req.user!.role, existing.tag)) throw new PartyInputError("Phone number belongs to a restricted party", 403);
        if (tag && tag !== existing.tag && (!canAssignTag(req.user!.role, tag) || !canAssignTag(req.user!.role, existing.tag))) {
          throw new PartyInputError("Only the Owner can change a VIP tag", 403);
        }
        const known = new Set(owners.map((o) => o.phone));
        const party = await prisma.party.update({
          where: { id: existing.id },
          data: {
            ...fields,
            ...(tag ? { tag } : {}),
            phones: { create: (normalized as string[]).filter((p) => !known.has(p)).map((phone) => ({ phone })) },
          },
          include: partyInclude,
        });
        await recordAudit({ userId: req.user!.id, action: "IMPORT_UPDATE", entityType: "Party", entityId: party.id, before: existing, after: party });
        results.push({ row, status: "updated", partyId: party.id });
      } else {
        const finalTag: PartyTag = tag ?? "UNKNOWN";
        if (!canAssignTag(req.user!.role, finalTag)) throw new PartyInputError(`Only the Owner can assign the ${finalTag} tag`, 403);
        const party = await prisma.party.create({
          data: { ...fields, tag: finalTag, phones: { create: [...new Set(normalized as string[])].map((phone) => ({ phone })) } },
          include: partyInclude,
        });
        await recordAudit({ userId: req.user!.id, action: "IMPORT_CREATE", entityType: "Party", entityId: party.id, after: party });
        results.push({ row, status: "created", partyId: party.id });
      }
    } catch (err) {
      if (err instanceof PartyInputError) {
        results.push({ row, status: "error", error: err.message });
        continue;
      }
      throw err;
    }
  }

  res.json({
    created: results.filter((r) => r.status === "created").length,
    updated: results.filter((r) => r.status === "updated").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
});
