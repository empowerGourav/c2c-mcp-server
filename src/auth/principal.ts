import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * The authorization context for one caller, resolved from a verified token subject.
 * `campaignRefs` is the complete row scope: queries never return data outside it.
 */
export interface C2cPrincipal {
  /** Privacy-safe principal identifier for audit logs (HMAC of the subject). */
  auditId: string;
  campaignRefs: ReadonlySet<string>;
}

/**
 * Resolves a verified OAuth subject to a C2C principal.
 * Implementations MUST fail closed: return `null` for unknown, disabled, or ambiguous users.
 */
export interface PrincipalResolver {
  resolve(subject: string): Promise<C2cPrincipal | null>;
}

const principalMapSchema = z.strictObject({
  version: z.number().int().positive(),
  principals: z.array(
    z.strictObject({
      subject: z.string().min(1),
      status: z.enum(['active', 'disabled']),
      campaignRefs: z.array(z.string().min(1).max(64)),
    }),
  ),
});

export type PrincipalMap = z.infer<typeof principalMapSchema>;

/**
 * Interim resolver backed by a reviewed, versioned JSON mapping file (plan §4.2: "explicit mapping
 * from authenticated C2C principals to allowed scopes").
 *
 * This stands in until the authoritative C2C permission source is confirmed (plan §11, decision 3);
 * a resolver that calls that source should implement the same interface.
 */
export class StaticPrincipalResolver implements PrincipalResolver {
  private readonly bySubject: Map<string, PrincipalMap['principals'][number]>;

  constructor(
    map: PrincipalMap,
    private readonly auditHashSalt: string,
    private readonly maxCampaignRefs: number,
  ) {
    this.bySubject = new Map();
    const duplicates = new Set<string>();
    for (const entry of map.principals) {
      if (this.bySubject.has(entry.subject)) duplicates.add(entry.subject);
      this.bySubject.set(entry.subject, entry);
    }
    // Ambiguous mappings fail closed: drop every duplicated subject entirely.
    for (const subject of duplicates) this.bySubject.delete(subject);
  }

  /**
   * Load and validate a mapping file.
   *
   * @throws {Error} When the file is unreadable or does not match the schema.
   */
  static async fromFile(path: string, auditHashSalt: string, maxCampaignRefs: number): Promise<StaticPrincipalResolver> {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    return new StaticPrincipalResolver(principalMapSchema.parse(raw), auditHashSalt, maxCampaignRefs);
  }

  async resolve(subject: string): Promise<C2cPrincipal | null> {
    const entry = this.bySubject.get(subject);
    if (!entry || entry.status !== 'active') return null;
    if (entry.campaignRefs.length === 0 || entry.campaignRefs.length > this.maxCampaignRefs) return null;
    return {
      auditId: hashSubject(subject, this.auditHashSalt),
      campaignRefs: new Set(entry.campaignRefs),
    };
  }
}

/**
 * Derive a stable, non-reversible principal identifier for logs.
 *
 * @param subject - Verified token subject.
 * @param salt - Secret salt (`AUDIT_HASH_SALT`).
 */
export function hashSubject(subject: string, salt: string): string {
  return createHmac('sha256', salt).update(subject).digest('hex').slice(0, 16);
}
