import type { LibrarySkill, SkillOrigin, SkillUpstream } from '@jian/contracts';
import { MAX_LIBRARY_SKILLS, skillImportSchema } from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { parseSkillDocument, type SkillDocument } from './document.js';
import type { SkillLibrary } from './library.js';
import { contentsUrl, pageUrl, parseSource, rawUrl, type Source } from './source.js';

/** Generous for a document, small enough that a wrong URL cannot stream into memory. */
const MAX_BYTES = 256 * 1024;

type Entry = { name: string; type: string };

export class Skills {
  constructor(
    private readonly library: Pick<SkillLibrary, 'addImported' | 'list' | 'refreshImported'>,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly clock: Clock = Date.now,
  ) {}

  private async read(url: string): Promise<string | null> {
    // A host that cannot be reached, or does not answer in time, is the repository's failure
    // to say, not the gateway's own.
    const response = await this.fetcher(url, {
      headers: { accept: 'text/plain, application/json', 'user-agent': 'jian-gateway' },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new GatewayError(502, 'GitHub could not be reached');
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
   * Copies the instructions into the library, and answers what it imported. Import is owner-only
   * and one-way: the skill is a snapshot, so a repository edited later never changes what the
   * agents already follow.
   */
  async importSkill(input: unknown): Promise<LibrarySkill[]> {
    const { url } = skillImportSchema.parse(input);
    const source = parseSource(url);
    const found: Array<SkillDocument & { url: string }> = [];

    const document = await this.read(rawUrl(source, this.documentPath(source.path)));

    if (document) {
      found.push({ ...parseSkillDocument(document, this.folderName(source.path)), url });
    } else {
      const directory = await this.skillDirectory(source);
      for (const child of directory.entries) {
        // More than the library holds could not be kept, so the folder is not read past it.
        if (
          child.type !== 'dir' ||
          child.name.startsWith('.') ||
          found.length >= MAX_LIBRARY_SKILLS
        ) {
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

    const origin = (at: string, license?: string): SkillOrigin => ({
      url: at,
      ref: source.ref,
      plugin: source.path.split('/').filter(Boolean).pop(),
      ...(license ? { license } : {}),
      importedAt: nowIso(this.clock),
    });

    return this.library.addImported(
      found.map((skill) => ({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        origin: origin(skill.url, skill.license),
      })),
    );
  }

  /**
   * The document an imported skill was copied from, read again: its address is the skill's own
   * folder, or its SKILL.md when it came with a folder of them. A skill that was not imported
   * has none, and a source that no longer holds the document is a failure to say, never a
   * reason to change the skill.
   */
  private async source(name: string): Promise<{ held: LibrarySkill; document: SkillDocument }> {
    const held = (await this.library.list()).find((skill) => skill.name === name);

    if (!held) throw new GatewayError(404, `There is no skill named ${name}`);
    if (!held.origin) throw new GatewayError(409, `${name} was not imported; it has no source`);

    const source = parseSource(held.origin.url);
    const text = await this.read(rawUrl(source, this.documentPath(source.path)));

    if (!text) throw new GatewayError(502, `${name} is no longer at its source`);

    return { held, document: parseSkillDocument(text, this.folderName(source.path)) };
  }

  /**
   * Whether the source says something else than the library holds. A skill edited here after
   * its import differs too: what the owner is told is that updating would change it.
   */
  async upstream(name: string): Promise<SkillUpstream> {
    const { held, document } = await this.source(name);

    return {
      changed:
        document.description !== held.description || document.instructions !== held.instructions,
      checkedAt: nowIso(this.clock),
    };
  }

  /** Copies the source's document over the skill, when the owner asks: never on its own. */
  async updateFromSource(name: string): Promise<LibrarySkill> {
    const { document } = await this.source(name);

    return this.library.refreshImported(name, document);
  }
}
