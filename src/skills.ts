import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const details = z.object({
  name: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(600),
  body: z.string().min(1).max(24000),
}).strict();

export interface SkillReference { id: string; version: number; name: string; summary: string }
export interface SavedSkill extends SkillReference { body: string; retired: number }

/** Existing members read the immutable revisions selected when they were created. */
export class SkillLibrary {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS skill_versions(
      id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL,
      body TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(id,version))`);
  }
  list(): SkillReference[] {
    return this.directory().filter(skill => !skill.retired).map(({retired: _retired, ...ref}) => ref);
  }
  directory(): (SkillReference & {retired:number})[] {
    return this.db.prepare(`SELECT s.id,s.version,s.name,s.summary,s.retired FROM skill_versions s
      WHERE s.version=(SELECT MAX(v.version) FROM skill_versions v WHERE v.id=s.id)
      ORDER BY s.retired,s.name,s.id`).all() as unknown as (SkillReference & {retired:number})[];
  }
  read(id: string, version?: number): SavedSkill {
    const row = this.db.prepare(`SELECT * FROM skill_versions WHERE id=? AND (? IS NULL OR version=?)
      ORDER BY version DESC LIMIT 1`).get(id, version ?? null, version ?? null);
    if (!row) throw new Error('Unknown Skill');
    return row as unknown as SavedSkill;
  }
  create(input: unknown): SavedSkill {
    return this.write(randomUUID(), 1, details.parse(input), false);
  }
  revise(id: string, expected: unknown, input: unknown, retire = false): SavedSkill {
    const current = this.read(id);
    if (current.retired || current.version !== expected) throw new Error('Skill version conflict');
    return this.write(id, current.version + 1, retire ? current : details.parse(input), retire);
  }
  private write(id: string, version: number, value: z.infer<typeof details>, retired: boolean) {
    const {name, summary, body} = value;
    this.db.prepare('INSERT INTO skill_versions(id,version,name,summary,body,retired) VALUES(?,?,?,?,?,?)')
      .run(id, version, name, summary, body, Number(retired));
    return {id,version,name,summary,body,retired:Number(retired)};
  }
  references(ids: readonly string[] = []): SkillReference[] {
    if (!ids.length) return [];
    const active = new Map(this.list().map(ref => [ref.id,ref]));
    return ids.flatMap(id => active.get(id) ?? []);
  }
  readForMember(refs: readonly SkillReference[], id: string, version: number): {body: string} {
    if (!refs.some(ref => ref.id === id && ref.version === version)) throw new Error('Skill revision is outside this member’s assignment');
    return {body: this.read(id,version).body};
  }
}
