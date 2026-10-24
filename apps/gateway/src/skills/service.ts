import type { Profile, SkillOrigin } from '@jian/contracts';
import { skillImportSchema } from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import type { ProfileAdmin } from '../profiles/port.js';
import { parseSkillDocument } from './document.js';
import { contentsUrl, pageUrl, parseSource, rawUrl, type Source } from './source.js';

/** Generous for a document, small enough that a wrong URL cannot stream into memory. */
const MAX_BYTES = 256 * 1024;
const MAX_SKILLS = 20;

type Entry = { name: string; type: string };

export class Skills {
  constructor(
    private readonly profiles: ProfileAdmin,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly clock: Clock = Date.now,
  ) {}

  private async read(url: string): Promise<string | null> {
    const response = await this.fetcher(url, {
      headers: { accept: 'text/plain, application/json', 'user-agent': 'jian-gateway' },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 404) {
      return null;
    }

    if (response.status === 403 || response.status === 429) {
      throw new GatewayError(429, 'GitHub is rate limiting this gateway; try again later');
    }

    if (!response.ok) {
      throw new GatewayError(502, `The repository answered ${response.status}`);
    }

    const text = await response.text();

    if (text.length > MAX_BYTES) {
      throw new GatewayError(413, 'The file is too large to be a skill');
    }

    return text;
  }

  private async listDirectory(source: Source, path: string): Promise<Entry[]> {
    const body = await this.read(contentsUrl(source, path));

    if (!body) {
      return [];
    }

    const parsed = JSON.parse(body) as unknown;

    return Array.isArray(parsed) ? (parsed as Entry[]) : [];
  }

  private async skillDirectory(source: Source): Promise<{ path: string; entries: Entry[] }> {
    const root = await this.listDirectory(source, source.path);
    const path = root.some((entry) => entry.type === 'dir' && entry.name === 'skills')
      ? `${source.path ? `${source.path}/` : ''}skills`
      : source.path;
    return { path, entries: path === source.path ? root : await this.listDirectory(source, path) };
  }

  private documentPath(path: string): string {
    return /SKILL\.md$/i.test(path) ? path : `${path ? `${path}/` : ''}SKILL.md`;
  }

  private folderName(path: string): string | undefined {
    return path
      .replace(/\/SKILL\.md$/i, '')
      .split('/')
      .pop();
  }

  /**
   * Copies the instructions into the profile. Import is owner-only and one-way: the skill is
   * a snapshot, so a repository edited later never changes what the agent already follows.
   */
  async importSkill(profileId: string, input: unknown): Promise<Profile> {
    const { url } = skillImportSchema.parse(input);
    const source = parseSource(url);
    const found: Array<{ name: string; description: string; instructions: string; url: string }> =
      [];

    const document = await this.read(rawUrl(source, this.documentPath(source.path)));

    if (document) {
      found.push({ ...parseSkillDocument(document, this.folderName(source.path)), url });
    } else {
      const directory = await this.skillDirectory(source);
      for (const child of directory.entries) {
        if (child.type !== 'dir' || child.name.startsWith('.') || found.length >= MAX_SKILLS) {
          continue;
        }

        const childPath = `${directory.path ? `${directory.path}/` : ''}${child.name}/SKILL.md`;
        const body = await this.read(rawUrl(source, childPath));

        if (body) {
          found.push({
            ...parseSkillDocument(body, child.name),
            url: pageUrl(source, childPath),
          });
        }
      }
    }

    if (!found.length) {
      throw new GatewayError(404, 'No SKILL.md found at that URL');
    }

    const profile = await this.profiles.profile(profileId);
    const origin = (at: string): SkillOrigin => ({
      url: at,
      ref: source.ref,
      plugin: source.path.split('/').filter(Boolean).pop(),
      importedAt: nowIso(this.clock),
    });

    const imported = found.map((skill) => ({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      origin: origin(skill.url),
    }));

    const kept = profile.skills.filter((skill) => !imported.some((s) => s.name === skill.name));
    const skills = [...kept, ...imported];

    if (skills.length > MAX_SKILLS) {
      throw new GatewayError(409, `A profile holds at most ${MAX_SKILLS} skills`);
    }

    return this.profiles.updateProfile(profileId, {
      expectedVersion: profile.version,
      skills,
    });
  }
}
