/**
 * Parsing for the CHANGELOG bundled into the About dialog.
 *
 * The renderer is MarkdownView, a deliberately small injection-safe subset,
 * so this module also strips constructs it cannot display: link-reference
 * definitions, horizontal rules and blockquote markers. Keeping the parsing
 * free of any `?raw` import makes it testable under plain `node --test`.
 */

export interface ReleaseSection {
  /** Version as written in the heading, e.g. "Unreleased" or "0.1.0". */
  version: string;
  /** Markdown body belonging to that heading. */
  body: string;
}

export interface ReleaseNotes {
  /** Document title + introductory text before the first version heading. */
  intro: string;
  sections: ReleaseSection[];
}

/** Accept both `## [0.1.0] - 2026-11-08` and `## 0.1.0 - 2026-11-08`. */
function headingVersion(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("## ")) return null;
  const rest = trimmed.slice(3).trim();
  const bracketed = /^\[([^\]]+)\]/.exec(rest);
  if (bracketed) return bracketed[1].trim();
  return rest.split(/\s+[-–]\s+/)[0].trim();
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\[[^\]]+\]:\s*\S+/.test(line.trim()))
    .filter((line) => !/^(-{3,}|\*{3,})\s*$/.test(line.trim()))
    .map((line) => line.replace(/^>\s?/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseReleaseNotes(markdown: string): ReleaseNotes {
  const intro: string[] = [];
  const versions: string[] = [];
  const bodies: string[][] = [];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const version = headingVersion(line);
    if (version) {
      versions.push(version);
      bodies.push([]);
    } else if (bodies.length > 0) {
      bodies[bodies.length - 1].push(line);
    } else {
      intro.push(line);
    }
  }
  return {
    intro: cleanMarkdown(intro.join("\n")),
    sections: versions.map((version, index) => ({
      version,
      body: cleanMarkdown(bodies[index].join("\n")),
    })),
  };
}

/** "Unreleased" is a Keep a Changelog convention, not a version number. */
export function releaseSectionLabel(version: string): string {
  const trimmed = version.trim();
  if (/^unreleased$/i.test(trimmed)) return "未发布变更";
  return `v${trimmed.replace(/^v/i, "")}`;
}
