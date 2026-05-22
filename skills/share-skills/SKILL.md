---
name: share-skills
description: Use when you need to author, package, or share a skill folder — understanding the SKILL.md format, where skills live, and how to bundle a folder so it can be shared with others.
---

# Sharing Skills

This skill explains how skills are structured and how to package one for sharing. It is a companion to skill authoring: where skill-creator helps you write a skill, this covers laying it out correctly and bundling it to hand off.

## Where skills live

Each skill is a folder under the `skills/` directory. The folder name is the skill's identity and must match the `name` field in its frontmatter (lowercase). At minimum a skill folder contains a `SKILL.md`; it may also include supporting files (scripts, reference docs, assets) the skill refers to.

```
skills/
  my-skill/
    SKILL.md
    reference.md        # optional supporting docs
    scripts/run.sh      # optional helper scripts
```

## SKILL.md format

A `SKILL.md` is a Markdown file with a YAML frontmatter block followed by the skill body.

```yaml
---
name: my-skill          # must equal the folder name, lowercase
description: Use when ...  # the "use when" trigger guidance, product-free
# optional eligibility keys (omit any that don't apply):
os: [darwin, linux]       # OS restriction
requires-bins: [foo]      # binaries that MUST be present
requires-any-bins: [a, b] # at least one of these binaries
requires-env: [MY_TOKEN]  # required environment variables
---
```

Body guidelines:

- Open with a short overview of what the skill does and when to reach for it.
- Keep instructions truthful: only describe actions the runtime can actually perform.
- Reference any supporting files by relative path within the folder.
- Keep it lean — the description and metadata are what get surfaced; the body is read on demand.

## Versioning a shared skill

When you intend to share a skill, keep a changelog note and a version in mind so recipients can tell revisions apart. A simple convention is a `## Changelog` section at the bottom of `SKILL.md` or a sibling `CHANGELOG.md`.

## Packaging a folder to share

To share a skill, bundle its entire folder (so supporting files travel with it) and hand it off as an archive.

```bash
# from the skills/ directory, archive a single skill folder
tar -czf my-skill.tar.gz my-skill/
```

The recipient unpacks the archive into their own `skills/` directory:

```bash
tar -xzf my-skill.tar.gz -C ./skills/
```

After unpacking, confirm the folder name still matches the `name` in frontmatter and that any `requires-*` eligibility keys are accurate for the new environment.

## Checklist before sharing

- `name` equals the folder name (lowercase).
- `description` is present and free of product names.
- Eligibility keys (`os` / `requires-bins` / `requires-any-bins` / `requires-env`) reflect real requirements — omit them when there are none.
- Supporting files are inside the folder and referenced by relative path.
- The body never instructs calling a tool the runtime does not have.
